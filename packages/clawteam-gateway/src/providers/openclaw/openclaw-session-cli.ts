/**
 * OpenClaw Session Client — CLI Implementation
 *
 * Sends messages to OpenClaw sessions via the `openclaw agent` CLI.
 * This is the primary implementation since OpenClaw exposes session
 * management through CLI commands, not HTTP REST endpoints.
 *
 * IMPORTANT: The `--session-id` CLI parameter accepts a real session ID (UUID),
 * NOT a session key. When `--agent` is provided, the CLI always resolves to the
 * agent's main session, ignoring `--session-id`. To route to a sub-session, we
 * must look up the real session ID from sessions.json and pass it via
 * `--session-id` WITHOUT `--agent`.
 *
 * CLI commands used:
 * - `openclaw agent --session-id <real-uuid> --message "..." --json`
 *   → Send message to a specific session (sub-session or main)
 * - `openclaw agent --agent <id> --message "..." --json`
 *   → Send message to agent's main/default session
 * - `openclaw sessions --json`
 *   → List sessions (used to check if a session is alive)
 *
 * Session key format: "agent:<agentId>:main" or "agent:<agentId>:subagent:<uuid>"
 */

import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { ISessionClient } from '../types.js';
import type { Logger } from 'pino';
import { buildOpenclawCliEnv } from './openclaw-env.js';

/** On Windows, spawn/execFile need shell:true to resolve .cmd/.bat shims */
const IS_WINDOWS = os.platform() === 'win32';

const execFileAsync = promisify(execFile);

/**
 * Short grace period (ms) after spawn to catch immediate failures
 * (ENOENT, bad args, gateway connection refused, etc.).
 * The CLI with `expectFinal: true` does NOT emit any stdout until the LLM
 * finishes, so we can't wait for a "delivery confirmation" JSON response.
 * Instead we assume: if the process is still alive after this window, the
 * message has been delivered to the gateway and the LLM is running.
 */
const SPAWN_GRACE_PERIOD_MS = 3_000;

/** Parse agentId from a session key like "agent:bob:main" → "bob" */
function parseAgentId(sessionKey: string): string | null {
  const parts = sessionKey.split(':');
  if (parts.length >= 2 && parts[0] === 'agent') {
    return parts[1];
  }
  return null;
}

export class OpenClawSessionCliClient implements ISessionClient {
  private readonly mainAgentId: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly openclawBin: string;
  /** Sessions updated within this window (ms) are considered alive */
  private readonly sessionAliveThresholdMs: number;
  private readonly openclawHome: string;

  constructor(
    mainAgentId: string,
    logger: Logger,
    options?: {
      timeoutMs?: number;
      openclawBin?: string;
      sessionAliveThresholdMs?: number;
      openclawHome?: string;
    },
  ) {
    this.mainAgentId = mainAgentId;
    this.logger = logger.child({ component: 'openclaw-session-cli' });
    this.timeoutMs = options?.timeoutMs ?? 120_000;
    this.openclawBin = options?.openclawBin ?? 'openclaw';
    this.sessionAliveThresholdMs = options?.sessionAliveThresholdMs ?? 24 * 60 * 60 * 1000; // 24h
    this.openclawHome = options?.openclawHome ?? path.join(os.homedir(), '.openclaw');
  }

  async sendToSession(sessionKey: string, message: string): Promise<boolean> {
    const agentId = parseAgentId(sessionKey);
    if (!agentId) {
      this.logger.error({ sessionKey }, 'Cannot parse agentId from session key');
      return false;
    }

    // Look up the real session ID (UUID) from sessions.json.
    // The OpenClaw CLI's --session-id param expects a real UUID, not a session key.
    // When --agent is provided, the CLI always routes to the agent's main session,
    // ignoring --session-id. So we must pass the real UUID WITHOUT --agent.
    const realSessionId = this.lookupSessionId(agentId, sessionKey);
    if (!realSessionId) {
      this.logger.error(
        { sessionKey, agentId },
        'Cannot find real sessionId in sessions.json for session key',
      );
      return false;
    }

    this.logger.info(
      { sessionKey, agentId, realSessionId, messageLength: message.length },
      'Sending message to session via CLI (fire-and-forget)',
    );

    // Fire-and-forget: spawn the CLI detached, wait only for delivery confirmation
    // from the gateway, then let the CLI process continue independently.
    // This prevents the timeout from killing the CLI process, which would cause
    // the gateway to abort the session's LLM call and archive the session.
    return this.spawnAndConfirmDelivery(sessionKey, realSessionId, message);
  }

  /**
   * Spawn the CLI as a detached process. Wait a short grace period to catch
   * immediate failures (binary not found, bad args, gateway unreachable).
   * If the process is still running after the grace period, assume the message
   * was delivered and detach — the LLM execution continues independently.
   *
   * The CLI calls `callGateway({ expectFinal: true })` which means it waits
   * for the full LLM response before printing anything to stdout. There is
   * NO early "delivery confirmation" JSON, so we cannot rely on stdout.
   */
  private spawnAndConfirmDelivery(
    sessionKey: string,
    realSessionId: string,
    message: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const args = IS_WINDOWS
        ? [
            'agent',
            '--session-id', `"${realSessionId}"`,
            '--message', `"${message.replace(/"/g, '\\"')}"`,
            '--json',
          ]
        : [
            'agent',
            '--session-id', realSessionId,
            '--message', message,
            '--json',
          ];

      const child = spawn(this.openclawBin, args, {
        detached: !IS_WINDOWS,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: IS_WINDOWS,
        env: buildOpenclawCliEnv(this.openclawHome),
      });

      let stderr = '';
      let settled = false;

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const settle = (success: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        // Fully detach — no background collection needed
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        child.removeAllListeners();
        child.unref();

        resolve(success);
      };

      // Grace period: if the process survives this window without error/exit,
      // the message has been delivered to the gateway and the LLM is running.
      const timer = setTimeout(() => {
        this.logger.info(
          { sessionKey },
          'CLI process still running after grace period — delivery assumed successful',
        );
        settle(true);
      }, SPAWN_GRACE_PERIOD_MS);

      child.on('error', (err) => {
        this.logger.error(
          { sessionKey, error: err.message },
          'CLI process spawn error',
        );
        settle(false);
      });

      child.on('exit', (code) => {
        if (!settled) {
          // Exited within grace period
          if (code === 0) {
            this.logger.info({ sessionKey }, 'CLI process exited cleanly');
            settle(true);
          } else {
            this.logger.error(
              { sessionKey, exitCode: code, stderr: stderr.substring(0, 500) },
              'CLI process exited with error',
            );
            settle(false);
          }
        }
      });
    });
  }

  async sendToMainSession(message: string, taskId?: string): Promise<boolean> {
    // Main session key format: agent:<mainAgentId>:main
    const mainSessionKey = `agent:${this.mainAgentId}:main`;
    const agentId = this.mainAgentId;

    let realSessionId = this.lookupSessionId(agentId, mainSessionKey);
    if (!realSessionId) {
      this.logger.warn(
        { mainSessionKey, agentId },
        'Main sessionId missing in sessions.json, attempting one-time reset',
      );
      const resetSessionId = await this.resetMainSession();
      if (resetSessionId) {
        realSessionId = resetSessionId;
      }
    }

    if (!realSessionId) {
      this.logger.error(
        { mainSessionKey, agentId },
        'Cannot find real sessionId in sessions.json for main session',
      );
      return false;
    }

    this.logger.info(
      { mainSessionKey, agentId, realSessionId, messageLength: message.length, taskId },
      'Sending message to main session via CLI',
    );

    return this.spawnAndConfirmDelivery(mainSessionKey, realSessionId, message);
  }

  async isSessionAlive(sessionKey: string): Promise<boolean> {
    const agentId = parseAgentId(sessionKey);
    if (!agentId) {
      this.logger.warn({ sessionKey }, 'Cannot parse agentId, assuming dead');
      return false;
    }

    this.logger.debug({ sessionKey, agentId }, 'Checking session status via CLI');

    try {
      const { stdout } = await execFileAsync(this.openclawBin, ['sessions', '--json'], {
        timeout: 10_000,
        shell: IS_WINDOWS,
        env: buildOpenclawCliEnv(this.openclawHome),
      });

      const data = this.parseJsonOutput(stdout);
      if (!data || !Array.isArray(data.sessions)) {
        this.logger.debug('No sessions data found');
        return false;
      }

      const session = data.sessions.find(
        (s: { key: string }) => s.key === sessionKey,
      );

      if (!session) {
        this.logger.debug({ sessionKey }, 'Session not found in sessions list');
        return false;
      }

      // Check if session was updated recently
      const ageMs = session.ageMs ?? (Date.now() - session.updatedAt);
      const alive = ageMs < this.sessionAliveThresholdMs;

      this.logger.debug(
        { sessionKey, ageMs, thresholdMs: this.sessionAliveThresholdMs, alive },
        'Session age check',
      );

      return alive;
    } catch (error) {
      this.logger.warn(
        { sessionKey, error: (error as Error).message },
        'Session status check failed, assuming dead',
      );
      return false;
    }
  }

  /**
   * Attempt to restore an archived/orphaned session by:
   * 1. Reading sessions.json to find the sessionId (UUID) for the session key
   * 2. Checking if the JSONL file exists (orphaned but restorable)
   * 3. If not, looking for .deleted.* archived files and renaming back
   * 4. Ensuring sessions.json has a valid entry for the session
   */
  async restoreSession(sessionKey: string): Promise<boolean> {
    const agentId = parseAgentId(sessionKey);
    if (!agentId) {
      this.logger.warn({ sessionKey }, 'Cannot parse agentId for restore');
      return false;
    }

    try {
      const sessionsDir = path.join(this.openclawHome, 'agents', agentId, 'sessions');
      const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');

      if (!fs.existsSync(sessionsJsonPath)) {
        this.logger.debug({ sessionsJsonPath }, 'sessions.json not found, cannot restore');
        return false;
      }

      // Read sessions.json — it's a dict keyed by session key:
      // { "agent:main:subagent:xxx": { "sessionId": "...", "updatedAt": ..., ... }, ... }
      const sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8'));
      const entry = (sessionsData[sessionKey] ?? sessionsData[`${sessionKey}:main`]) as
        | { sessionId?: string; updatedAt?: number; systemSent?: boolean }
        | undefined;
      const sessionId = entry?.sessionId;

      if (!sessionId) {
        this.logger.debug({ sessionKey }, 'No sessionId found in sessions.json for this key');
        return false;
      }

      const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`);

      // Case 1: JSONL file exists — session is restorable as-is (orphaned or threshold issue)
      if (fs.existsSync(jsonlPath)) {
        this.logger.info({ sessionKey, sessionId }, 'JSONL file exists, session is restorable');
        return true;
      }

      // Case 2: Look for archived .deleted.* files
      const files = fs.readdirSync(sessionsDir);
      const archivedFile = files.find((f) => f.startsWith(`${sessionId}.jsonl.deleted.`));

      if (!archivedFile) {
        this.logger.debug({ sessionKey, sessionId }, 'No archived JSONL file found');
        return false;
      }

      // Rename archived file back to active
      const archivedPath = path.join(sessionsDir, archivedFile);
      fs.renameSync(archivedPath, jsonlPath);
      this.logger.info(
        { sessionKey, sessionId, archivedFile },
        'Restored archived session file',
      );

      // Ensure sessions.json still has a valid entry (re-read in case it changed)
      const updatedData = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8'));
      const existingEntry = updatedData[sessionKey];

      if (!existingEntry || existingEntry.sessionId !== sessionId) {
        // Re-add a minimal entry
        updatedData[sessionKey] = {
          sessionId,
          updatedAt: Date.now(),
          systemSent: false,
        };
        fs.writeFileSync(sessionsJsonPath, JSON.stringify(updatedData, null, 2));
        this.logger.info({ sessionKey, sessionId }, 'Re-added session entry to sessions.json');
      }

      return true;
    } catch (error) {
      this.logger.warn(
        { sessionKey, error: (error as Error).message },
        'Session restore failed',
      );
      return false;
    }
  }

  /**
   * Reverse-lookup: given a raw session ID (UUID), find the session key
   * by scanning sessions.json for the main agent.
   */
  resolveSessionKeyFromId(sessionId: string): string | undefined {
    try {
      const sessionsJsonPath = path.join(
        this.openclawHome, 'agents', this.mainAgentId, 'sessions', 'sessions.json',
      );
      if (!fs.existsSync(sessionsJsonPath)) {
        return undefined;
      }
      const data = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8'));
      for (const [key, entry] of Object.entries(data)) {
        if ((entry as any)?.sessionId === sessionId) {
          return key;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Look up the real session ID (UUID) for a session key from sessions.json.
   * Returns undefined if not found.
   */
  private lookupSessionId(agentId: string, sessionKey: string): string | undefined {
    try {
      const sessionsJsonPath = path.join(
        this.openclawHome, 'agents', agentId, 'sessions', 'sessions.json',
      );
      if (!fs.existsSync(sessionsJsonPath)) {
        return undefined;
      }
      const data = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8'));
      // Try exact key first, then fallback to key + ":main" for 2-part keys like "agent:main"
      return data[sessionKey]?.sessionId
        ?? data[`${sessionKey}:main`]?.sessionId;
    } catch {
      return undefined;
    }
  }

  /**
   * Reset the main session via `openclaw gateway call sessions.reset`.
   * Archives the old JSONL transcript and assigns a new session ID.
   * Returns the new session ID or null on failure.
   */
  async resetMainSession(): Promise<string | null> {
    const mainSessionKey = `agent:${this.mainAgentId}:main`;
    this.logger.info({ mainSessionKey }, 'Resetting main session via gateway');

    try {
      const paramsJson = JSON.stringify({ key: mainSessionKey });
      const args = IS_WINDOWS
        ? ['gateway', 'call', 'sessions.reset', '--params', `"${paramsJson.replace(/"/g, '\\"')}"`, '--json']
        : ['gateway', 'call', 'sessions.reset', '--params', paramsJson, '--json'];
      const { stdout } = await execFileAsync(
        this.openclawBin,
        args,
        {
          timeout: 15_000,
          shell: IS_WINDOWS,
          env: buildOpenclawCliEnv(this.openclawHome),
        },
      );

      const data = this.parseJsonOutput(stdout);
      if (data?.ok && data?.entry?.sessionId) {
        this.logger.info(
          { mainSessionKey, newSessionId: data.entry.sessionId },
          'Main session reset successfully',
        );
        return data.entry.sessionId;
      }

      this.logger.warn({ mainSessionKey, data }, 'Main session reset returned unexpected response');
      return null;
    } catch (error) {
      this.logger.error(
        { mainSessionKey, error: (error as Error).message },
        'Main session reset failed',
      );
      return null;
    }
  }

  private parseJsonOutput(stdout: string): any {
    // The CLI may output non-JSON lines before the JSON payload.
    // Try to find and parse the JSON portion.
    const trimmed = stdout.trim();

    // Try direct parse first
    try {
      return JSON.parse(trimmed);
    } catch {
      // Try to find JSON object or array in the output
      const jsonStart = trimmed.indexOf('{');
      const jsonArrayStart = trimmed.indexOf('[');
      const start = jsonStart === -1
        ? jsonArrayStart
        : jsonArrayStart === -1
          ? jsonStart
          : Math.min(jsonStart, jsonArrayStart);

      if (start >= 0) {
        try {
          return JSON.parse(trimmed.substring(start));
        } catch {
          // ignore
        }
      }
    }

    return null;
  }
}

// Re-export the interface for convenience
export type { ISessionClient } from '../types.js';
