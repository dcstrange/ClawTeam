/**
 * Gateway API Server
 *
 * Lightweight Fastify HTTP + WebSocket server exposing router state,
 * real-time events, and gateway proxy endpoints for LLM access.
 */

import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { Logger } from 'pino';
import type { SessionTracker } from '../routing/session-tracker.js';
import type { TaskRouter } from '../routing/router.js';
import type { TaskPollingLoop } from '../polling/task-poller.js';
import type { HeartbeatLoop } from '../monitoring/heartbeat-loop.js';
import type { SessionStatusResolver } from '../monitoring/session-status-resolver.js';
import type { ISessionClient } from '../providers/types.js';
import type { IClawTeamApiClient } from '../clients/clawteam-api.js';
import type { RoutingResult } from '../types.js';
import type { TaskSessionStatus } from '../monitoring/types.js';
import type { RoutedTasksTracker } from '../routing/routed-tasks.js';
import { registerGatewayRoutes } from '../gateway/gateway-proxy.js';
import { RouteHistory } from './route-history.js';
import type {
  RouterStatusResponse,
  RouterWsEvent,
  TaskRoutedEvent,
  SessionStateChangedEvent,
  PollCompleteEvent,
} from './types.js';

export interface RouterApiDeps {
  sessionTracker: SessionTracker;
  router: TaskRouter;
  poller: TaskPollingLoop;
  heartbeatLoop: HeartbeatLoop | null;
  resolver: SessionStatusResolver | null;
  sessionClient: ISessionClient | null;
  clawteamApi: IClawTeamApiClient | null;
  clawteamApiUrl: string;
  clawteamApiKey: string;
  clawteamBotId?: string;
  pollIntervalMs: number;
  logger: Logger;
  routedTasks?: RoutedTasksTracker;
  gatewayProxyEnabled: boolean;
  gatewayUrl: string;
  onBotIdChanged?: (newBotId: string) => void;
}

export class RouterApiServer {
  private readonly server;
  private readonly sessionTracker: SessionTracker;
  private readonly router: TaskRouter;
  private readonly poller: TaskPollingLoop;
  private readonly heartbeatLoop: HeartbeatLoop | null;
  private readonly resolver: SessionStatusResolver | null;
  private readonly sessionClient: ISessionClient | null;
  private readonly clawteamApi: IClawTeamApiClient | null;
  private readonly clawteamApiUrl: string;
  private readonly pollIntervalMs: number;
  private readonly logger: Logger;
  private readonly routeHistory: RouteHistory;
  private readonly routedTasks: RoutedTasksTracker | null;
  private readonly clawteamApiKey: string;
  private clawteamBotId?: string;
  private readonly gatewayProxyEnabled: boolean;
  private readonly gatewayUrl: string;
  private readonly onBotIdChanged?: (newBotId: string) => void;
  private gatewayProxyDeps: import('../gateway/types.js').GatewayProxyDeps | null = null;
  private readonly startedAt = Date.now();
  private readonly maxWsClients = 10;

  constructor(deps: RouterApiDeps) {
    this.sessionTracker = deps.sessionTracker;
    this.router = deps.router;
    this.poller = deps.poller;
    this.heartbeatLoop = deps.heartbeatLoop;
    this.resolver = deps.resolver;
    this.sessionClient = deps.sessionClient;
    this.clawteamApi = deps.clawteamApi;
    this.clawteamApiUrl = deps.clawteamApiUrl;
    this.pollIntervalMs = deps.pollIntervalMs;
    this.logger = deps.logger.child({ component: 'router-api' });
    this.routeHistory = new RouteHistory(100);
    this.routedTasks = deps.routedTasks ?? null;
    this.clawteamApiKey = deps.clawteamApiKey;
    this.clawteamBotId = deps.clawteamBotId;
    this.gatewayProxyEnabled = deps.gatewayProxyEnabled;
    this.gatewayUrl = deps.gatewayUrl;
    this.onBotIdChanged = deps.onBotIdChanged;

    this.server = Fastify({ logger: false, connectionTimeout: 10_000 });
    this.setupRoutes();
    this.setupEventListeners();
  }

  setBotId(newBotId: string): void {
    this.clawteamBotId = newBotId;
    if (this.gatewayProxyDeps) {
      this.gatewayProxyDeps.clawteamBotId = newBotId;
    }
    this.logger.info({ botId: newBotId }, 'RouterApiServer botId updated');
  }

  private setupRoutes(): void {
    this.server.register(fastifyWebsocket);

    // Gateway proxy endpoints (/gateway/*)
    if (this.gatewayProxyEnabled) {
      const proxyDeps = {
        clawteamApiUrl: this.clawteamApiUrl,
        clawteamApiKey: this.clawteamApiKey,
        clawteamBotId: this.clawteamBotId,
        sessionTracker: this.sessionTracker,
        logger: this.logger,
        onBotIdChanged: this.onBotIdChanged,
      };
      this.gatewayProxyDeps = proxyDeps;
      registerGatewayRoutes(this.server, proxyDeps);
      this.logger.info('Gateway proxy routes registered');
    }

    // REST endpoints
    this.server.get('/status', async () => {
      const stats = this.sessionTracker.getStats();
      const resp: RouterStatusResponse = {
        uptime: Date.now() - this.startedAt,
        trackedTasks: stats.trackedTasks,
        activeSessions: stats.activeSessions,
        pollerRunning: true,
        heartbeatRunning: this.heartbeatLoop !== null,
        pollIntervalMs: this.pollIntervalMs,
      };
      return resp;
    });

    this.server.get('/sessions', async () => {
      if (!this.resolver) {
        return { sessions: [] };
      }
      const sessions = await this.resolver.resolveAllSessions();
      return { sessions };
    });

    this.server.get<{ Params: { key: string } }>('/sessions/:key', async (req) => {
      if (!this.resolver) {
        return { error: 'Resolver not available' };
      }
      const sessionKey = decodeURIComponent(req.params.key);
      const cliSessions = await this.resolver.fetchCliSessions();
      const cliMap = new Map(cliSessions.map(s => [s.key, s]));
      // Find a task for this session
      const tasks = this.sessionTracker.getTasksForSession(sessionKey);
      if (tasks.length === 0) {
        return { error: 'Session not tracked' };
      }
      const status = this.resolver.resolveOne(tasks[0], sessionKey, cliMap);
      return status;
    });

    this.server.get('/tasks', async () => {
      return { tasks: this.sessionTracker.getAllTracked() };
    });

    this.server.get('/routes/history', async () => {
      return { entries: this.routeHistory.getAll() };
    });

    // Cancel endpoint: send cancellation message to a task's session, then cancel via API
    this.server.post<{ Params: { taskId: string }; Body: { reason?: string } }>('/tasks/:taskId/cancel', async (req) => {
      const { taskId } = req.params;
      const reason = (req.body as any)?.reason ?? 'Cancelled from dashboard';

      if (!this.sessionClient || !this.clawteamApi) {
        return { success: false, reason: 'Cancel not available (missing dependencies)' };
      }

      const sessionKey = this.sessionTracker.getSessionForTask(taskId);
      const task = await this.clawteamApi.getTask(taskId);
      if (!task) {
        return { success: false, reason: 'Task not found' };
      }

      const CANCELLABLE = new Set(['pending', 'accepted', 'processing', 'waiting_for_input']);
      if (!CANCELLABLE.has(task.status)) {
        return { success: false, reason: `Task not cancellable (status: ${task.status})` };
      }

      // Step 1: If task has an active session, send cancellation message
      let sessionNotified = false;
      if (sessionKey) {
        const message = [
          '[ClawTeam Task -- CANCELLED]',
          `Task ID: ${taskId}`,
          `Capability: ${task.capability}`,
          `Reason: ${reason}`,
          '',
          'This task has been cancelled by the dashboard operator.',
          'Please STOP all work on this task immediately.',
          'Do NOT call the complete endpoint. The task is already cancelled.',
        ].join('\n');

        sessionNotified = await this.sessionClient.sendToSession(sessionKey, message);
        this.logger.info({ taskId, sessionKey, sessionNotified }, 'Cancel message sent to session');
      }

      // Step 2: Cancel via API (DB + Redis cleanup)
      let apiCancelled = false;
      try {
        const apiUrl = this.clawteamApiUrl.replace(/\/$/, '');
        const res = await fetch(`${apiUrl}/api/v1/tasks/all/${taskId}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        });
        const body = await res.json() as { success: boolean };
        apiCancelled = body.success;
      } catch (err) {
        this.logger.error({ taskId, error: (err as Error).message }, 'API cancel request failed');
      }

      // Step 3: Untrack from session tracker
      if (sessionKey) {
        this.sessionTracker.untrack(taskId);
      }

      return {
        success: apiCancelled,
        action: 'cancel',
        taskId,
        sessionKey: sessionKey || null,
        sessionNotified,
        apiCancelled,
        reason,
      };
    });

    // Nudge endpoint: manually send a nudge message to a task's session
    this.server.post<{ Params: { taskId: string } }>('/tasks/:taskId/nudge', async (req) => {
      const { taskId } = req.params;

      if (!this.sessionClient || !this.clawteamApi) {
        return { success: false, reason: 'Nudge not available (missing dependencies)' };
      }

      const sessionKey = this.sessionTracker.getSessionForTask(taskId);
      if (!sessionKey) {
        return { success: false, reason: 'Task not tracked' };
      }

      const task = await this.clawteamApi.getTask(taskId);
      if (!task) {
        return { success: false, reason: 'Task not found' };
      }

      const NUDGEABLE = new Set(['accepted', 'processing']);
      if (!NUDGEABLE.has(task.status)) {
        return { success: false, reason: 'Task not in active state' };
      }

      const message = [
        '[ClawTeam Task -- Manual Nudge]',
        `Task ID: ${taskId}`,
        `Capability: ${task.capability}`,
        `Status: ${task.status}`,
        '',
        'This is a manual nudge from the dashboard operator.',
        'Please continue working on the task and complete it when done.',
        '',
        `Complete: POST $CLAWTEAM_API_URL/api/v1/tasks/${taskId}/complete`,
      ].join('\n');

      const sent = await this.sessionClient.sendToSession(sessionKey, message);
      this.logger.info({ taskId, sessionKey, sent }, sent ? 'Manual nudge sent' : 'Manual nudge failed');

      return { success: sent, action: 'nudge', sessionKey, reason: sent ? 'Nudge sent' : 'Send failed' };
    });

    // Resume endpoint: unified resume for waiting_for_input AND completed/failed/timeout tasks.
    // When both input and targetBotId are provided, validates the target session is alive first.
    this.server.post<{ Params: { taskId: string }; Body: { input?: string; humanInput?: string; prompt?: string; targetBotId?: string } }>('/tasks/:taskId/resume', async (req) => {
      const { taskId } = req.params;
      const body = (req.body || {}) as any;
      const input = body.input ?? body.humanInput ?? body.prompt;
      const targetBotId = body.targetBotId;

      // When both input and targetBotId are present, validate session is alive
      if (input && targetBotId) {
        let sessionKey = this.sessionTracker.getSessionForTask(taskId);

        // Fallback: fetch from API if in-memory tracker lost the mapping
        if (!sessionKey && this.clawteamApi) {
          try {
            const task = await this.clawteamApi.getTask(taskId);
            if (task?.executorSessionKey) {
              sessionKey = task.executorSessionKey;
              this.logger.info({ taskId, sessionKey }, 'Resolved sessionKey from task.executorSessionKey (in-memory tracker miss)');
            }
          } catch (err) {
            this.logger.warn({ taskId, error: (err as Error).message }, 'Failed to fetch task for sessionKey fallback');
          }
        }

        let alive = false;
        if (sessionKey && this.sessionClient) {
          try {
            alive = await this.sessionClient.isSessionAlive(sessionKey);
          } catch (err) {
            this.logger.warn({ taskId, sessionKey, error: (err as Error).message }, 'Session alive check failed');
          }

          // Try restoring archived session before giving up
          if (!alive && this.sessionClient.restoreSession) {
            try {
              const restored = await this.sessionClient.restoreSession(sessionKey);
              if (restored) {
                this.logger.info({ taskId, sessionKey }, 'Session restored from archive for resume');
                alive = true;
              }
            } catch (restoreErr) {
              this.logger.warn({ taskId, sessionKey, error: (restoreErr as Error).message }, 'Session restore attempt failed');
            }
          }
        }

        if (!alive) {
          this.logger.warn({ taskId, sessionKey: sessionKey || 'none' }, 'Resume rejected: session not alive and not restorable');
          return {
            success: false,
            reason: 'session_lost',
            detail: 'The session for this task is no longer active and could not be restored. The bot may need to be restarted.',
          };
        }
      }

      try {
        const apiUrl = this.clawteamApiUrl.replace(/\/$/, '');
        const res = await fetch(`${apiUrl}/api/v1/tasks/${taskId}/resume`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.clawteamApiKey}`,
            ...(this.clawteamBotId ? { 'X-Bot-Id': this.clawteamBotId } : {}),
          },
          body: JSON.stringify({ ...(input ? { input } : {}), ...(targetBotId ? { targetBotId } : {}) }),
        });
        const resBody = await res.json() as { success: boolean; error?: any };

        if (!resBody.success) {
          return { success: false, reason: 'API resume failed', detail: resBody.error };
        }

        this.logger.info({ taskId, hasInput: !!input, targetBotId }, 'Task resumed via API');
        return { success: true, action: 'resume', taskId };
      } catch (err) {
        this.logger.error({ taskId, error: (err as Error).message }, 'Resume failed');
        return { success: false, reason: (err as Error).message };
      }
    });

    // Reset main session: archives old transcript and assigns a new session ID
    this.server.post('/sessions/main/reset', async () => {
      if (!this.sessionClient?.resetMainSession) {
        return { success: false, message: 'Reset not available (missing session client or method)' };
      }

      const newSessionId = await this.sessionClient.resetMainSession();
      if (newSessionId) {
        this.logger.info({ newSessionId }, 'Main session reset via API');
        return { success: true, newSessionId };
      }

      return { success: false, message: 'Reset failed -- check router logs' };
    });

    // DEPRECATED: /delegate-intent has been removed.
    // Delegate intent is now inbox-driven: Dashboard → API /api/v1/tasks/:taskId/delegate-intent → inbox → Gateway poll.

    // DEPRECATED: MCP Server notify endpoints -- originally called by clawteam-skill on accept/complete.
    // Now superseded by /gateway/* proxy endpoints which handle session tracking directly.
    // Kept for backward compatibility; may be removed in a future version.
    this.server.post<{ Body: { taskId: string; executorSessionKey: string } }>('/notify/task-accepted', async (req) => {
      const { taskId, executorSessionKey } = req.body as any;
      if (!taskId) {
        return { success: false, error: 'taskId is required' };
      }

      if (executorSessionKey) {
        this.sessionTracker.track(taskId, executorSessionKey);
      }
      if (this.routedTasks) {
        this.routedTasks.markRouted(taskId);
      }

      this.logger.info({ taskId, executorSessionKey }, 'Task accepted notification received');
      return { success: true };
    });

    this.server.post<{ Body: { taskId: string; status: string } }>('/notify/task-completed', async (req) => {
      const { taskId, status } = req.body as any;
      if (!taskId) {
        return { success: false, error: 'taskId is required' };
      }

      this.sessionTracker.untrack(taskId);

      this.logger.info({ taskId, status }, 'Task completed notification received');
      return { success: true };
    });

    // WebSocket endpoint (with connection limit and idle timeout)
    this.server.register(async (app) => {
      app.get('/ws', { websocket: true }, (socket) => {
        const clientCount = this.server.websocketServer?.clients?.size ?? 0;
        if (clientCount > this.maxWsClients) {
          this.logger.warn({ clientCount, max: this.maxWsClients }, 'WebSocket connection limit reached, closing new connection');
          socket.close(1013, 'Too many connections');
          return;
        }

        this.logger.info({ clientCount: clientCount + 1 }, 'WebSocket client connected');

        // Idle timeout: close connections that haven't received a pong in 60s
        let alive = true;
        const pingInterval = setInterval(() => {
          if (!alive) {
            this.logger.info('WebSocket client timed out (no pong), closing');
            socket.terminate();
            return;
          }
          alive = false;
          socket.ping();
        }, 30_000);

        socket.on('pong', () => { alive = true; });

        socket.on('close', () => {
          clearInterval(pingInterval);
          this.logger.info({ clientCount: (this.server.websocketServer?.clients?.size ?? 0) }, 'WebSocket client disconnected');
        });

        socket.on('error', (err) => {
          clearInterval(pingInterval);
          this.logger.warn({ error: err.message }, 'WebSocket client error');
        });
      });
    });
  }

  private setupEventListeners(): void {
    // Listen to router events
    this.router.on('task_routed', (result: RoutingResult, reason: string) => {
      this.routeHistory.push({
        timestamp: Date.now(),
        taskId: result.taskId,
        action: result.action,
        sessionKey: result.sessionKey,
        success: result.success,
        reason,
        fallback: result.fallback,
        error: result.error,
      });

      this.broadcast({
        type: 'task_routed',
        taskId: result.taskId,
        action: result.action,
        sessionKey: result.sessionKey,
        success: result.success,
        reason,
      });
    });

    // Listen to poller events
    this.poller.on('poll_complete', (data: PollCompleteEvent) => {
      this.broadcast(data);
    });

    // Listen to heartbeat events
    if (this.heartbeatLoop) {
      this.heartbeatLoop.on('session_state_changed', (status: TaskSessionStatus) => {
        this.broadcast({
          type: 'session_state_changed',
          taskId: status.taskId,
          sessionKey: status.sessionKey,
          state: status.sessionState,
          details: status.details,
        });
      });
    }
  }

  private broadcast(event: RouterWsEvent): void {
    const clients = this.server.websocketServer?.clients;
    if (!clients || clients.size === 0) return;

    const msg = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        try {
          client.send(msg);
        } catch {
          // Skip failed clients
        }
      }
    }
  }

  async start(port: number): Promise<void> {
    await this.server.listen({ port, host: '127.0.0.1' });
    this.logger.info({ port }, 'Gateway API server started');
  }

  async stop(): Promise<void> {
    await this.server.close();
    this.logger.info('Gateway API server stopped');
  }
}
