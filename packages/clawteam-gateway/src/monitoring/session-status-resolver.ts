/**
 * Session Status Resolver
 *
 * Combines CLI session status (alive/dead) with JSONL file analysis
 * to derive a comprehensive SessionState for each tracked task.
 *
 * Data flow:
 * 1. `openclaw sessions --json` → alive/dead + ageMs for each session
 * 2. JSONL tail analysis → lastRole, stopReason, toolCallCount, etc.
 * 3. deriveState() truth table → final SessionState
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import type {
  CliSessionInfo,
  JsonlAnalysis,
  SessionState,
  SessionStatusDetails,
  TaskSessionStatus,
} from './types.js';
import { analyzeTail, buildJsonlPath } from './jsonl-analyzer.js';
import type { SessionTracker } from '../routing/session-tracker.js';
import { buildOpenclawCliEnv } from '../utils/openclaw-env.js';

/** On Windows, execFile needs shell:true to resolve .cmd shims */
const IS_WINDOWS = os.platform() === 'win32';

const execFileAsync = promisify(execFile);

/** Parse agentId from a session key like "agent:bob:main" → "bob" */
function parseAgentId(sessionKey: string): string | null {
  const parts = sessionKey.split(':');
  if (parts.length >= 2 && parts[0] === 'agent') {
    return parts[1];
  }
  return null;
}

/** Look up the real session UUID from sessions.json */
function lookupSessionId(
  openclawHome: string,
  agentId: string,
  sessionKey: string,
): string | null {
  try {
    const sessionsJsonPath = path.join(
      openclawHome, 'agents', agentId, 'sessions', 'sessions.json',
    );
    if (!fs.existsSync(sessionsJsonPath)) {
      return null;
    }
    const data = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8'));
    return data[sessionKey]?.sessionId ?? null;
  } catch {
    return null;
  }
}

export interface SessionStatusResolverOptions {
  openclawBin: string;
  openclawHome: string;
  sessionAliveThresholdMs: number;
  sessionTracker: SessionTracker;
  logger: Logger;
}

export class SessionStatusResolver {
  private readonly openclawBin: string;
  private readonly openclawHome: string;
  private readonly sessionAliveThresholdMs: number;
  private readonly sessionTracker: SessionTracker;
  private readonly logger: Logger;

  constructor(options: SessionStatusResolverOptions) {
    this.openclawBin = options.openclawBin;
    this.openclawHome = options.openclawHome;
    this.sessionAliveThresholdMs = options.sessionAliveThresholdMs;
    this.sessionTracker = options.sessionTracker;
    this.logger = options.logger.child({ component: 'session-status-resolver' });
  }

  /**
   * Resolve the status of all sessions.
   *
   * Delegates to resolveAllSessions() which scans the filesystem directly.
   */
  async resolveAll(): Promise<TaskSessionStatus[]> {
    return this.resolveAllSessions();
  }

  /**
   * Resolve the status of a single task's session.
   */
  resolveOne(
    taskId: string,
    sessionKey: string,
    cliMap: Map<string, CliSessionInfo>,
  ): TaskSessionStatus {
    const agentId = parseAgentId(sessionKey);
    const cliInfo = cliMap.get(sessionKey);

    // Determine if alive from CLI
    const alive = cliInfo?.alive ?? false;
    const ageMs = cliInfo?.ageMs ?? null;

    // Look up session ID and analyze JSONL
    let sessionId: string | null = null;
    let analysis: JsonlAnalysis | null = null;

    if (agentId) {
      sessionId = cliInfo?.sessionId ?? lookupSessionId(this.openclawHome, agentId, sessionKey);
      if (sessionId) {
        const jsonlPath = buildJsonlPath(this.openclawHome, agentId, sessionId);
        analysis = analyzeTail(jsonlPath);
      }
    }

    const sessionState = deriveState(alive, analysis);

    // Estimate last activity time
    let lastActivityAt: Date | null = null;
    if (cliInfo?.updatedAt) {
      lastActivityAt = new Date(cliInfo.updatedAt);
    } else if (ageMs !== null) {
      lastActivityAt = new Date(Date.now() - ageMs);
    }

    return {
      taskId,
      sessionKey,
      sessionState,
      lastActivityAt,
      details: {
        alive,
        jsonlAnalysis: analysis,
        ageMs,
        agentId,
        sessionId,
      },
    };
  }

  /**
   * Fetch session info from `openclaw sessions --json`.
   */
  async fetchCliSessions(): Promise<CliSessionInfo[]> {
    try {
      const { stdout } = await execFileAsync(this.openclawBin, ['sessions', '--json'], {
        timeout: 10_000,
        shell: IS_WINDOWS,
        env: buildOpenclawCliEnv(this.openclawHome),
      });

      const data = parseJsonOutput(stdout);
      if (!data || !Array.isArray(data.sessions)) {
        return [];
      }

      return data.sessions.map((s: any) => {
        const ageMs = s.ageMs ?? (s.updatedAt ? Date.now() - s.updatedAt : undefined);
        return {
          key: s.key,
          sessionId: s.sessionId,
          ageMs,
          updatedAt: s.updatedAt,
          alive: ageMs !== undefined ? ageMs < this.sessionAliveThresholdMs : false,
        };
      });
    } catch (error) {
      this.logger.warn(
        { error: (error as Error).message },
        'Failed to fetch CLI sessions',
      );
      return [];
    }
  }

  /**
   * Resolve status for ALL sessions by scanning the filesystem directly.
   *
   * Unlike resolveAll() which depends on SessionTracker's tracked pairs,
   * this method scans ~/.openclaw/agents/ to discover every session,
   * mirroring the logic in cli-status.ts's collectEntries().
   *
   * Data flow:
   * 1. Scan agents directory for agent IDs
   * 2. Read each agent's sessions/sessions.json
   * 3. Fetch CLI sessions for alive/age info
   * 4. Analyze JSONL tail for each session
   * 5. Derive state and return TaskSessionStatus[]
   */
  async resolveAllSessions(): Promise<TaskSessionStatus[]> {
    const agentsDir = path.join(this.openclawHome, 'agents');

    let agentIds: string[] = [];
    try {
      if (fs.existsSync(agentsDir)) {
        agentIds = fs.readdirSync(agentsDir).filter((name) => {
          const sessionsDir = path.join(agentsDir, name, 'sessions');
          return fs.existsSync(sessionsDir);
        });
      }
    } catch (error) {
      this.logger.warn({ error: (error as Error).message }, 'Failed to scan agents directory');
      return [];
    }

    if (agentIds.length === 0) {
      this.logger.debug('No agents found in agents directory');
      return [];
    }

    const cliSessions = await this.fetchCliSessions();
    const cliMap = new Map<string, CliSessionInfo>();
    for (const s of cliSessions) {
      cliMap.set(s.key, s);
    }

    const results: TaskSessionStatus[] = [];

    for (const agentId of agentIds) {
      const sessionsJsonPath = path.join(agentsDir, agentId, 'sessions', 'sessions.json');
      if (!fs.existsSync(sessionsJsonPath)) continue;

      let sessionsData: Record<string, any>;
      try {
        sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8'));
      } catch {
        continue;
      }

      for (const [sessionKey, entry] of Object.entries(sessionsData)) {
        const sessionId = (entry as any)?.sessionId ?? null;
        const cliInfo = cliMap.get(sessionKey);
        const alive = cliInfo?.alive ?? false;
        const ageMs = cliInfo?.ageMs ?? null;

        let analysis: JsonlAnalysis | null = null;
        if (sessionId) {
          const jsonlPath = buildJsonlPath(this.openclawHome, agentId, sessionId);
          analysis = analyzeTail(jsonlPath);
        }

        const sessionState = deriveState(alive, analysis);

        let lastActivityAt: Date | null = null;
        if (cliInfo?.updatedAt) {
          lastActivityAt = new Date(cliInfo.updatedAt);
        } else if (ageMs !== null) {
          lastActivityAt = new Date(Date.now() - ageMs);
        }

        results.push({
          taskId: sessionKey, // Use sessionKey as taskId when no task tracking
          sessionKey,
          sessionState,
          lastActivityAt,
          details: {
            alive,
            jsonlAnalysis: analysis,
            ageMs,
            agentId,
            sessionId,
          },
        });
      }
    }

    return results;
  }

  /**
   * Resolve status for a specific set of task→session pairs.
   */
  async resolveForTasks(pairs: Array<{ taskId: string; sessionKey: string }>): Promise<TaskSessionStatus[]> {
    const cliSessions = await this.fetchCliSessions();
    const cliMap = new Map<string, CliSessionInfo>();
    for (const s of cliSessions) {
      cliMap.set(s.key, s);
    }

    const results: TaskSessionStatus[] = [];

    for (const { taskId, sessionKey } of pairs) {
      try {
        const status = this.resolveOne(taskId, sessionKey, cliMap);
        results.push(status);
      } catch (error) {
        this.logger.warn(
          { taskId, sessionKey, error: (error as Error).message },
          'Failed to resolve status for task',
        );
        results.push({
          taskId,
          sessionKey,
          sessionState: 'unknown',
          lastActivityAt: null,
          details: {
            alive: false,
            jsonlAnalysis: null,
            ageMs: null,
            agentId: parseAgentId(sessionKey),
            sessionId: null,
          },
        });
      }
    }

    return results;
  }
}

/**
 * Derive SessionState from alive status and JSONL analysis.
 *
 * The `alive` flag is based on session age from the CLI, which can be
 * misleading for long-running sessions. JSONL analysis takes precedence:
 * if the JSONL shows the session is actively working (tool_calling, active,
 * waiting), we trust that over the age-based alive flag.
 *
 * Truth table:
 * | alive | analysis | lastRole     | stopReason | → State       |
 * |-------|----------|--------------|------------|---------------|
 * | false | null     | -            | -          | dead          |
 * | false | present  | (active*)    | *          | (from JSONL)  |
 * | false | present  | (inactive)   | *          | dead          |
 * | true  | null     | -            | -          | idle          |
 * | true  | present  | assistant    | error      | errored       |
 * | true  | present  | assistant    | stop       | completed     |
 * | true  | present  | assistant    | toolUse    | tool_calling  |
 * | true  | present  | toolResult   | *          | active        |
 * | true  | present  | user         | *          | waiting       |
 * | true  | present  | null         | *          | idle          |
 */
export function deriveState(alive: boolean, analysis: JsonlAnalysis | null): SessionState {
  if (!alive) {
    // Age-based check says dead, but JSONL might show active work
    if (!analysis) return 'dead';
    const jsonlState = deriveFromJsonl(analysis);
    // If JSONL shows active work, trust it over the age-based flag
    const activeStates: SessionState[] = ['active', 'tool_calling', 'waiting'];
    return activeStates.includes(jsonlState) ? jsonlState : 'dead';
  }
  if (!analysis) return 'idle';
  return deriveFromJsonl(analysis);
}

/** Derive state purely from JSONL analysis. */
function deriveFromJsonl(analysis: JsonlAnalysis): SessionState {
  const { lastMessageRole, lastStopReason } = analysis;

  if (!lastMessageRole) return 'idle';

  switch (lastMessageRole) {
    case 'assistant':
      switch (lastStopReason) {
        case 'error': return 'errored';
        case 'stop': return 'completed';
        case 'toolUse': return 'tool_calling';
        default: return 'active'; // assistant message without clear stop = still generating
      }
    case 'toolResult':
      return 'active'; // Tool result returned, LLM processing
    case 'user':
      return 'waiting'; // Waiting for LLM response
    default:
      return 'unknown';
  }
}

/**
 * Parse JSON from CLI output (may contain non-JSON prefix or suffix lines,
 * e.g. plugin console.log output appended after the JSON).
 */
function parseJsonOutput(stdout: string): any {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const jsonStart = trimmed.indexOf('{');
    const jsonArrayStart = trimmed.indexOf('[');
    const start = jsonStart === -1
      ? jsonArrayStart
      : jsonArrayStart === -1
        ? jsonStart
        : Math.min(jsonStart, jsonArrayStart);

    if (start >= 0) {
      const closer = trimmed[start] === '{' ? '}' : ']';
      const end = trimmed.lastIndexOf(closer);
      if (end > start) {
        try {
          return JSON.parse(trimmed.substring(start, end + 1));
        } catch {
          // ignore
        }
      }
    }
  }
  return null;
}
