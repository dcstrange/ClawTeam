/**
 * ClawTeam API Client
 *
 * HTTP client for the ClawTeam Platform API.
 * Uses native fetch (Node 18+) with Bearer token auth.
 */

import type { Task } from '@clawteam/shared/types';
import type { ActiveTasksResponse, InboxMessage, InboxPollResponse, PollResponse, TaskResponse } from '../types.js';
import type { HeartbeatPayload } from '../monitoring/types.js';
import type { Logger } from 'pino';

export interface IClawTeamApiClient {
  pollPendingTasks(limit?: number): Promise<Task[]>;
  pollActiveTasks(limit?: number): Promise<Task[]>;
  pollInbox(limit?: number): Promise<InboxMessage[]>;
  acceptTask(taskId: string, executorSessionKey?: string): Promise<void>;
  startTask(taskId: string): Promise<void>;
  getTask(taskId: string): Promise<Task | null>;
  getBot(botId: string): Promise<{ id: string; name: string; ownerEmail?: string } | null>;
  sendHeartbeat(taskId: string, payload: HeartbeatPayload): Promise<void>;
  resetTask(taskId: string): Promise<boolean>;
  failTask(taskId: string, reason: string): Promise<boolean>;
  cancelTask(taskId: string, reason: string): Promise<boolean>;
  ackMessage(messageId: string): Promise<boolean>;
  updateSessionKey(taskId: string, keys: { senderSessionKey?: string; executorSessionKey?: string }): Promise<void>;
  trackSession(taskId: string, sessionKey: string, botId: string, role?: string): Promise<boolean>;
  getSessionForTaskBot(taskId: string, botId: string): Promise<string | null>;
  getSessionsForBot(botId: string): Promise<Array<{ taskId: string; sessionKey: string; role: string }>>;
}

export class ClawTeamApiClient implements IClawTeamApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private botId?: string;
  private readonly logger: Logger;
  private readonly timeoutMs = 10_000;

  constructor(baseUrl: string, apiKey: string, logger: Logger, botId?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.botId = botId;
    this.logger = logger.child({ component: 'clawteam-api-client' });
  }

  setBotId(newBotId: string): void {
    this.botId = newBotId;
    this.logger.info({ botId: newBotId }, 'ClawTeamApiClient botId updated');
  }

  async pollPendingTasks(limit: number = 10): Promise<Task[]> {
    const url = `${this.baseUrl}/api/v1/tasks/pending?limit=${limit}`;
    this.logger.debug({ url }, 'Polling pending tasks');

    const response = await this.fetch(url);
    const body = (await response.json()) as PollResponse;

    if (!body.success || !body.data) {
      this.logger.warn({ error: body.error }, 'Poll returned unsuccessful');
      return [];
    }

    return body.data.tasks;
  }

  async pollActiveTasks(limit: number = 50): Promise<Task[]> {
    const url = `${this.baseUrl}/api/v1/tasks?status=pending,accepted,processing&role=to&limit=${limit}`;
    this.logger.debug({ url }, 'Polling active tasks');

    const response = await this.fetch(url);
    const body = (await response.json()) as ActiveTasksResponse;

    if (!body.success || !body.data) {
      this.logger.warn({ error: body.error }, 'Active tasks poll returned unsuccessful');
      return [];
    }

    return body.data.items;
  }

  async pollInbox(limit: number = 10): Promise<InboxMessage[]> {
    const url = `${this.baseUrl}/api/v1/messages/inbox?limit=${limit}`;
    this.logger.debug({ url }, 'Polling inbox');

    const response = await this.fetch(url);
    const body = (await response.json()) as InboxPollResponse;

    if (!body.success || !body.data) {
      this.logger.warn({ error: body.error }, 'Inbox poll returned unsuccessful');
      return [];
    }

    return body.data.messages;
  }

  async acceptTask(taskId: string, executorSessionKey?: string): Promise<void> {
    const url = `${this.baseUrl}/api/v1/tasks/${taskId}/accept`;
    this.logger.debug({ taskId }, 'Accepting task');

    const response = await this.fetch(url, {
      method: 'POST',
      body: JSON.stringify({ executorSessionKey }),
    });

    const body = await response.json();
    if (!(body as any).success) {
      throw new Error(`Failed to accept task ${taskId}: ${JSON.stringify((body as any).error)}`);
    }
  }

  async startTask(taskId: string): Promise<void> {
    const url = `${this.baseUrl}/api/v1/tasks/${taskId}/start`;
    this.logger.debug({ taskId }, 'Starting task');

    const response = await this.fetch(url, {
      method: 'POST',
    });

    const body = await response.json();
    if (!(body as any).success) {
      throw new Error(`Failed to start task ${taskId}: ${JSON.stringify((body as any).error)}`);
    }
  }

  async getTask(taskId: string): Promise<Task | null> {
    const url = `${this.baseUrl}/api/v1/tasks/${taskId}`;
    this.logger.debug({ taskId }, 'Getting task details');

    const response = await this.fetch(url);

    if (response.status === 404) {
      return null;
    }

    const body = (await response.json()) as TaskResponse;
    if (!body.success || !body.data) {
      return null;
    }

    return body.data;
  }

  async getBot(botId: string): Promise<{ id: string; name: string; ownerEmail?: string } | null> {
    const url = `${this.baseUrl}/api/v1/bots/${botId}`;
    try {
      const response = await this.fetch(url);
      if (response.status === 404) return null;
      const body = await response.json() as any;
      if (!body.success || !body.data) return null;
      return body.data;
    } catch {
      return null;
    }
  }

  async resetTask(taskId: string): Promise<boolean> {
    const url = `${this.baseUrl}/api/v1/tasks/${taskId}/reset`;
    this.logger.debug({ taskId }, 'Resetting task to pending');

    try {
      const response = await this.fetch(url, { method: 'POST', body: '{}' });
      const body = await response.json();

      if ((body as any).success) {
        this.logger.info({ taskId }, 'Task reset to pending via API');
        return true;
      }

      this.logger.warn(
        { taskId, status: response.status, error: (body as any).error },
        'Task reset failed',
      );
      return false;
    } catch (error) {
      this.logger.warn(
        { taskId, error: (error as Error).message },
        'Task reset request failed',
      );
      return false;
    }
  }

  async failTask(taskId: string, reason: string): Promise<boolean> {
    const url = `${this.baseUrl}/api/v1/tasks/${taskId}/complete`;
    try {
      const response = await this.fetch(url, {
        method: 'POST',
        body: JSON.stringify({
          status: 'failed',
          error: { code: 'RECOVERY_EXHAUSTED', message: reason },
        }),
      });
      const body = await response.json();
      if ((body as any).success) {
        this.logger.info({ taskId }, 'Task marked as failed via API');
        return true;
      }
      this.logger.warn({ taskId, status: response.status, error: (body as any).error }, 'Task fail request rejected');
      return false;
    } catch (error) {
      this.logger.warn({ taskId, error: (error as Error).message }, 'Task fail request failed');
      return false;
    }
  }

  async cancelTask(taskId: string, reason: string): Promise<boolean> {
    const url = `${this.baseUrl}/api/v1/tasks/all/${taskId}/cancel`;
    try {
      const response = await this.fetch(url, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      const body = await response.json();
      if ((body as any).success) {
        this.logger.info({ taskId }, 'Task cancelled via API');
        return true;
      }
      this.logger.warn({ taskId, status: response.status, error: (body as any).error }, 'Task cancel request rejected');
      return false;
    } catch (error) {
      this.logger.warn({ taskId, error: (error as Error).message }, 'Task cancel request failed');
      return false;
    }
  }

  async ackMessage(messageId: string): Promise<boolean> {
    const url = `${this.baseUrl}/api/v1/messages/${messageId}/ack`;
    try {
      const response = await this.fetch(url, { method: 'POST', body: '{}' });
      const body = await response.json();
      return (body as any).success === true;
    } catch (error) {
      this.logger.warn(
        { messageId, error: (error as Error).message },
        'Message ACK failed',
      );
      return false;
    }
  }

  async sendHeartbeat(taskId: string, payload: HeartbeatPayload): Promise<void> {
    const url = `${this.baseUrl}/api/v1/tasks/${taskId}/heartbeat`;
    this.logger.debug({ taskId, sessionStatus: payload.sessionStatus }, 'Sending heartbeat');

    try {
      await this.fetch(url, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      // Fire-and-forget: don't check response body
    } catch (error) {
      this.logger.warn(
        { taskId, error: (error as Error).message },
        'Heartbeat send failed',
      );
    }
  }

  async updateSessionKey(taskId: string, keys: { senderSessionKey?: string; executorSessionKey?: string }): Promise<void> {
    const url = `${this.baseUrl}/api/v1/tasks/${taskId}/session-key`;
    this.logger.debug({ taskId, keys }, 'Updating session key');

    const response = await this.fetch(url, {
      method: 'PATCH',
      body: JSON.stringify(keys),
    });

    const body = await response.json();
    if (!(body as any).success) {
      throw new Error(`Failed to update session key for task ${taskId}: ${JSON.stringify((body as any).error)}`);
    }
  }

  async trackSession(taskId: string, sessionKey: string, botId: string, role: string = 'executor'): Promise<boolean> {
    const url = `${this.baseUrl}/api/v1/tasks/${taskId}/track-session`;
    try {
      const response = await this.fetch(url, {
        method: 'POST',
        body: JSON.stringify({ sessionKey, botId, role }),
      });
      const body = await response.json();
      return (body as any).success === true;
    } catch (error) {
      this.logger.warn(
        { taskId, botId, error: (error as Error).message },
        'track-session persist to API failed',
      );
      return false;
    }
  }

  async getSessionForTaskBot(taskId: string, botId: string): Promise<string | null> {
    const url = `${this.baseUrl}/api/v1/tasks/${taskId}/sessions`;
    try {
      const response = await this.fetch(url);
      const body = await response.json();
      if (!(body as any).success) {
        this.logger.warn(
          { taskId, botId, status: response.status, body },
          'getSessionForTaskBot: API returned success=false',
        );
        return null;
      }

      const sessions: Array<{ botId: string; sessionKey: string }> = (body as any).data?.sessions || [];
      const match = sessions.find((s) => s.botId === botId);
      this.logger.info(
        { taskId, botId, sessionsCount: sessions.length, matchFound: !!match, matchKey: match?.sessionKey },
        'getSessionForTaskBot: query result',
      );
      return match?.sessionKey ?? null;
    } catch (error) {
      this.logger.warn(
        { taskId, botId, error: (error as Error).message },
        'getSessionForTaskBot: FAILED',
      );
      return null;
    }
  }

  async getSessionsForBot(botId: string): Promise<Array<{ taskId: string; sessionKey: string; role: string }>> {
    const url = `${this.baseUrl}/api/v1/tasks/sessions-by-bot?botId=${encodeURIComponent(botId)}`;
    try {
      const response = await this.fetch(url);
      const body = await response.json();
      if (!(body as any).success) {
        this.logger.warn(
          { botId, status: response.status, error: (body as any).error },
          'getSessionsForBot: API returned success=false',
        );
        return [];
      }

      const sessions = ((body as any).data?.sessions || []).map((s: any) => ({
        taskId: s.taskId,
        sessionKey: s.sessionKey,
        role: s.role,
      }));
      this.logger.info(
        { botId, count: sessions.length },
        'getSessionsForBot: API returned sessions',
      );
      return sessions;
    } catch (error) {
      this.logger.warn(
        { botId, url, error: (error as Error).message },
        'getSessionsForBot: FAILED (network/parse error)',
      );
      return [];
    }
  }

  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...(this.botId ? { 'X-Bot-Id': this.botId } : {}),
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
