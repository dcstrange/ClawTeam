/**
 * OpenClaw Session Client
 *
 * HTTP client for the OpenClaw session management API.
 * The TaskRouter only sends messages to sessions — it does NOT spawn sessions.
 * Session spawning is the main session's responsibility.
 *
 * Session tracking (taskId ↔ childSessionKey) is now handled by the
 * clawteam-auto-tracker OpenClaw plugin via before_tool_call / after_tool_call
 * hooks on sessions_spawn. The plugin calls /gateway/track-session to link
 * the task to the sub-session.
 */
import type { SessionSendResponse, SessionStatusResponse } from '../../types.js';
import type { Logger } from 'pino';


export { type ISessionClient } from '../types.js';
import type { ISessionClient } from '../types.js';

/**
 * @deprecated Use ISessionClient from '../types.js' instead.
 * Kept as a re-export alias for backward compatibility during migration.
 */
export type IOpenClawSessionClient = ISessionClient;

export class OpenClawSessionClient implements ISessionClient {
  private readonly baseUrl: string;
  private readonly mainSessionId: string;
  private readonly apiKey?: string;
  private readonly logger: Logger;
  private readonly timeoutMs = 10_000;

  constructor(
    baseUrl: string,
    mainSessionId: string,
    logger: Logger,
    apiKey?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.mainSessionId = mainSessionId;
    this.apiKey = apiKey;
    this.logger = logger.child({ component: 'openclaw-session-client' });
  }

  async sendToSession(sessionKey: string, message: string): Promise<boolean> {
    const url = `${this.baseUrl}/sessions/send`;
    this.logger.debug({ sessionKey, messageLength: message.length }, 'Sending to session');

    try {
      const response = await this.fetch(url, {
        method: 'POST',
        body: JSON.stringify({ sessionKey, message }),
      });

      const body = (await response.json()) as SessionSendResponse;

      if (!body.success) {
        this.logger.warn({ sessionKey, error: body.error }, 'Session send failed');
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error({ sessionKey, error: (error as Error).message }, 'Session send error');
      return false;
    }
  }

  async sendToMainSession(message: string, _taskId?: string): Promise<boolean> {
    return this.sendToSession(this.mainSessionId, message);
  }

  async isSessionAlive(sessionKey: string): Promise<boolean> {
    const url = `${this.baseUrl}/sessions/${sessionKey}/status`;
    this.logger.debug({ sessionKey }, 'Checking session status');

    try {
      const response = await this.fetch(url);

      if (!response.ok) {
        return false;
      }

      const body = (await response.json()) as SessionStatusResponse;
      return body.alive;
    } catch (error) {
      this.logger.warn(
        { sessionKey, error: (error as Error).message },
        'Session status check failed, assuming dead',
      );
      return false;
    }
  }

  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          ...headers,
          ...init?.headers,
        },
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error(`Request to ${url} timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
