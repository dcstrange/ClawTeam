/**
 * Gateway Proxy
 *
 * Provides /gateway/* endpoints that proxy to the ClawTeam API Server.
 * LLM calls Gateway via curl, Gateway adds auth and forwards to API.
 * All endpoints use the config-level API key (no per-bot key store).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { GatewayProxyDeps } from './types.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  formatRegisterResponse,
  formatBotsResponse,
  formatBotDetailResponse,
  formatDelegateResponse,
  formatPendingTasksResponse,
  formatAcceptResponse,
  formatCompleteResponse,
  formatCancelResponse,
  formatTaskStatusResponse,
  formatSendMessageResponse,
  formatInboxResponse,
  formatAckResponse,
  formatErrorResponse,
  formatSubmitResultResponse,
  formatApproveResponse,
  formatRejectResponse,
} from './response-formatter.js';

function textReply(reply: FastifyReply, text: string, status = 200): void {
  reply.status(status).type('text/plain; charset=utf-8').send(text);
}

async function proxyFetch(
  url: string,
  opts: RequestInit,
): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

/** Unwrap API's { success, data } envelope, returning the inner payload */
function unwrap(body: any): any {
  return body?.data !== undefined ? body.data : body;
}

function authHeaders(apiKey: string, botId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (botId) headers['X-Bot-Id'] = botId;
  return headers;
}

/**
 * Write botId into ~/.clawteam/config.yaml after successful registration.
 * If the file has an existing `botId:` line under `api:`, update it in-place.
 * Otherwise append it after the `key:` line.
 */
function saveBotIdToConfig(newBotId: string, logger: GatewayProxyDeps['logger']): void {
  const configPath = path.join(os.homedir(), '.clawteam', 'config.yaml');
  try {
    if (!fs.existsSync(configPath)) return;
    let content = fs.readFileSync(configPath, 'utf-8');

    if (/^\s+botId:/m.test(content)) {
      // Replace existing botId line
      content = content.replace(/^(\s+botId:).*$/m, `$1 ${newBotId}`);
    } else {
      // Insert after the `key:` line under `api:`
      content = content.replace(/^(\s+key:.*$)/m, `$1\n  botId: ${newBotId}`);
    }

    fs.writeFileSync(configPath, content, 'utf-8');
    logger.info({ botId: newBotId, path: configPath }, 'Auto-saved botId to config.yaml');
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'Failed to auto-save botId to config.yaml');
  }
}

/**
 * Extract sessionKey from request body, auto-track if taskId is present,
 * and return a clean body with sessionKey removed (API server doesn't need it).
 */
function extractAndTrackSession(
  body: Record<string, any>,
  taskId: string,
  deps: {
    sessionTracker: GatewayProxyDeps['sessionTracker'];
    logger: GatewayProxyDeps['logger'];
    clawteamBotId?: string;
    clawteamApiUrl?: string;
    clawteamApiKey?: string;
  },
  defaultRole: 'sender' | 'executor' = 'executor',
): Record<string, any> {
  const { sessionKey, sessionKeyRole, ...clean } = body;
  if (!sessionKey || !taskId) return body;
  const effectiveRole = sessionKeyRole === 'sender' || sessionKeyRole === 'executor'
    ? sessionKeyRole
    : defaultRole;

  deps.sessionTracker.track(taskId, sessionKey);
  deps.logger.info({ taskId, sessionKey, role: effectiveRole }, 'Auto-tracked session via sessionKey in request body');

  // Best-effort persist to API server
  const botId = deps.clawteamBotId;
  if (botId && deps.clawteamApiUrl && deps.clawteamApiKey) {
    const apiBase = deps.clawteamApiUrl.replace(/\/$/, '');
    proxyFetch(`${apiBase}/api/v1/tasks/${taskId}/track-session`, {
      method: 'POST',
      headers: authHeaders(deps.clawteamApiKey, botId),
      body: JSON.stringify({ sessionKey, botId, role: effectiveRole }),
    }).catch((err) => {
      deps.logger.warn({ taskId, error: (err as Error).message }, 'Auto-track persist to API failed');
    });
  }

  return clean;
}

export function registerGatewayRoutes(server: FastifyInstance, deps: GatewayProxyDeps): void {
  const apiBase = deps.clawteamApiUrl.replace(/\/$/, '');
  const log = deps.logger;
  const key = deps.clawteamApiKey;

  /** Shorthand for extractAndTrackSession with gateway deps */
  const autoTrack = (
    body: Record<string, any>,
    taskId: string,
    defaultRole: 'sender' | 'executor' = 'executor',
  ) =>
    extractAndTrackSession(body, taskId, {
      sessionTracker: deps.sessionTracker,
      logger: log,
      clawteamBotId: deps.clawteamBotId,
      clawteamApiUrl: deps.clawteamApiUrl,
      clawteamApiKey: key,
    }, defaultRole);

  // 1. POST /gateway/register — register bot using config API key
  server.post('/gateway/register', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = req.body as any;
      const res = await proxyFetch(`${apiBase}/api/v1/bots/register`, {
        method: 'POST',
        headers: authHeaders(key, deps.clawteamBotId),
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        textReply(reply, formatErrorResponse(`Registration failed (HTTP ${res.status}): ${typeof res.data === 'string' ? res.data : JSON.stringify(res.data)}`), res.status);
        return;
      }

      const payload = unwrap(res.data);
      const registeredBotId = payload.botId || payload.id;
      log.info({ botId: registeredBotId }, 'Bot registered via gateway proxy');

      // Auto-save botId to config so gateway uses it on next restart
      if (registeredBotId) {
        saveBotIdToConfig(registeredBotId, log);
        deps.onBotIdChanged?.(registeredBotId);
      }

      textReply(reply, formatRegisterResponse(payload));
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Gateway register failed');
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 1b. GET /gateway/me — return this bot's identity (for plugin self-awareness)
  server.get('/gateway/me', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!deps.clawteamBotId) {
      textReply(reply, formatErrorResponse('Bot ID not configured'), 500);
      return;
    }
    try {
      const res = await proxyFetch(`${apiBase}/api/v1/bots/${deps.clawteamBotId}`, {
        headers: authHeaders(key, deps.clawteamBotId),
      });
      if (!res.ok) { textReply(reply, formatErrorResponse(`HTTP ${res.status}`), res.status); return; }
      reply.type('application/json').send(unwrap(res.data));
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 2. GET /gateway/bots
  server.get('/gateway/bots', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const res = await proxyFetch(`${apiBase}/api/v1/bots`, {
        headers: authHeaders(key, deps.clawteamBotId),
      });
      if (!res.ok) { textReply(reply, formatErrorResponse(`HTTP ${res.status}`), res.status); return; }
      let bots = unwrap(res.data);
      // Filter out self to prevent self-delegation
      if (Array.isArray(bots) && deps.clawteamBotId) {
        bots = bots.filter((b: any) => b.id !== deps.clawteamBotId && b.botId !== deps.clawteamBotId);
      }
      textReply(reply, formatBotsResponse(Array.isArray(bots) ? bots : []));
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 3. GET /gateway/bots/:botId
  server.get<{ Params: { botId: string } }>('/gateway/bots/:botId', async (req, reply) => {
    try {
      const res = await proxyFetch(`${apiBase}/api/v1/bots/${req.params.botId}`, {
        headers: authHeaders(key, deps.clawteamBotId),
      });
      if (!res.ok) { textReply(reply, formatErrorResponse(`HTTP ${res.status}`), res.status); return; }
      textReply(reply, formatBotDetailResponse(unwrap(res.data)));
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 3b. POST /gateway/tasks/create — create a task record without enqueuing or notifying
  // Proxies to /api/v1/tasks/create (pure DB INSERT, no queue, no inbox).
  // Returns taskId. The caller then spawns a sub-session, calls track-session,
  // and the sub-session delegates the task via /gateway/tasks/:taskId/delegate.
  server.post('/gateway/tasks/create', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = req.body as Record<string, any> | undefined;
      log.info({ body }, '[plugin-trace] /gateway/tasks/create called');

      const res = await proxyFetch(`${apiBase}/api/v1/tasks/create`, {
        method: 'POST',
        headers: authHeaders(key, deps.clawteamBotId),
        body: JSON.stringify(body),
      });

      if (!res.ok) { textReply(reply, formatErrorResponse(`Create task failed (HTTP ${res.status}): ${typeof res.data === 'string' ? res.data : JSON.stringify(res.data)}`), res.status); return; }

      const payload = unwrap(res.data);
      const taskId = payload?.taskId || payload?.id;
      log.info({ taskId }, 'Task created via /gateway/tasks/create (DB only, not enqueued)');

      // Return JSON for programmatic callers (dashboard, plugin), plain text for LLM sessions
      const accept = (req.headers['accept'] || '') as string;
      if (accept.includes('application/json')) {
        reply.type('application/json').send({ success: true, taskId, data: payload });
      } else {
        textReply(reply, formatDelegateResponse(payload));
      }
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 3b2. POST /gateway/tasks/:taskId/delegate — set toBotId, enqueue + notify
  // Called by the delegation sub-session to deliver the task to the executor.
  server.post<{ Params: { taskId: string } }>('/gateway/tasks/:taskId/delegate', async (req, reply) => {
    const { taskId } = req.params;
    const body = autoTrack((req.body || {}) as Record<string, any>, taskId, 'sender');

    // Block self-delegation
    if (deps.clawteamBotId && body.toBotId === deps.clawteamBotId) {
      log.warn({ taskId, toBotId: body.toBotId }, 'Blocked self-delegation attempt');
      textReply(reply, formatErrorResponse('Self-delegation is not allowed. You cannot delegate a task to yourself. Pick a DIFFERENT bot.'), 400);
      return;
    }

    try {
      const res = await proxyFetch(`${apiBase}/api/v1/tasks/${taskId}/delegate`, {
        method: 'POST',
        headers: authHeaders(key, deps.clawteamBotId),
        body: JSON.stringify(body),
      });
      if (!res.ok) { textReply(reply, formatErrorResponse(`Delegate failed (HTTP ${res.status}): ${typeof res.data === 'string' ? res.data : JSON.stringify(res.data)}`), res.status); return; }

      log.info({ taskId, toBotId: body.toBotId }, 'Task delegated via /gateway/tasks/:taskId/delegate');
      textReply(reply, `Task ${taskId} delegated to ${body.toBotId} (enqueued and notification sent).`);
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 3c. POST /gateway/track-session -- link sessionKey to taskId (pure track)
  // All roles (sender, executor) do the same thing: sessionTracker.track().
  // role param is kept for logging only.
  server.post('/gateway/track-session', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as Record<string, any> | undefined;
    const taskId = body?.taskId as string | undefined;
    const sessionKey = body?.sessionKey as string | undefined;
    const role = (body?.role as string | undefined) || 'executor';

    log.info({ taskId, sessionKey, role, body }, '[plugin-trace] /gateway/track-session called');

    if (!sessionKey) {
      textReply(reply, formatErrorResponse('Missing sessionKey'), 400);
      return;
    }

    if (taskId) {
      deps.sessionTracker.track(taskId, sessionKey);
      log.info({ taskId, sessionKey, role }, 'Tracked session via /gateway/track-session');

      // Persist to API Server (best-effort, non-blocking)
      const botId = deps.clawteamBotId;
      if (botId) {
        proxyFetch(`${apiBase}/api/v1/tasks/${taskId}/track-session`, {
          method: 'POST',
          headers: authHeaders(key, botId),
          body: JSON.stringify({ sessionKey, botId, role }),
        }).catch((err) => {
          log.warn({ taskId, error: (err as Error).message }, 'track-session persist to API failed');
        });
      }
    } else {
      log.info({ sessionKey, role }, 'Session registered (no taskId yet)');
    }

    textReply(reply, taskId
      ? `Tracked: taskId=${taskId} session=${sessionKey} role=${role}`
      : `Session registered: session=${sessionKey} role=${role}`);
  });

  // 5. GET /gateway/tasks/pending
  server.get('/gateway/tasks/pending', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const res = await proxyFetch(`${apiBase}/api/v1/tasks/pending`, {
        headers: authHeaders(key, deps.clawteamBotId),
      });
      if (!res.ok) { textReply(reply, formatErrorResponse(`HTTP ${res.status}`), res.status); return; }
      textReply(reply, formatPendingTasksResponse(unwrap(res.data)));
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 6. POST /gateway/tasks/:taskId/accept — accept + track session
  // API accept now goes directly pending → processing (no separate start needed).
  // This endpoint remains as a fallback in case the sub-session calls curl accept
  // (e.g. from cached prompts or recovery scenarios). The API accept is idempotent.
  server.post<{ Params: { taskId: string } }>('/gateway/tasks/:taskId/accept', async (req, reply) => {
    const { taskId } = req.params;
    const body = autoTrack((req.body || {}) as Record<string, any>, taskId);
    try {
      const acceptBody = { ...body };
      if (!acceptBody.executorSessionKey) {
        const tracked = deps.sessionTracker.getSessionForTask(taskId);
        if (tracked) {
          acceptBody.executorSessionKey = tracked;
        }
      }

      const acceptRes = await proxyFetch(`${apiBase}/api/v1/tasks/${taskId}/accept`, {
        method: 'POST',
        headers: authHeaders(key, deps.clawteamBotId),
        body: JSON.stringify(acceptBody),
      });
      if (!acceptRes.ok) { textReply(reply, formatErrorResponse(`Accept failed (HTTP ${acceptRes.status})`), acceptRes.status); return; }

      // Track session — but don't overwrite if plugin already set a valid key
      const executorSessionKey = body.executorSessionKey as string | undefined;
      if (executorSessionKey) {
        const existing = deps.sessionTracker.getSessionForTask(taskId);
        if (!existing || !existing.startsWith('agent:')) {
          deps.sessionTracker.track(taskId, executorSessionKey);
        }
      }

      log.info({ taskId, executorSessionKey }, 'Task accepted via gateway proxy');
      textReply(reply, formatAcceptResponse(taskId));
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 7. POST /gateway/tasks/:taskId/complete — complete + untrack session
  // Only the delegator (fromBotId) can call /complete. Executors must use /submit-result.
  server.post<{ Params: { taskId: string } }>('/gateway/tasks/:taskId/complete', async (req, reply) => {
    const { taskId } = req.params;
    const body = autoTrack((req.body || {}) as Record<string, any>, taskId);
    try {
      const res = await proxyFetch(`${apiBase}/api/v1/tasks/${taskId}/complete`, {
        method: 'POST',
        headers: authHeaders(key, deps.clawteamBotId),
        body: JSON.stringify(body),
      });

      if (!res.ok && res.status === 403) {
        // Executor called /complete — return clear error
        textReply(reply, formatErrorResponse(
          `Executors cannot call /complete. Only the delegator (task creator) can complete a task. ` +
          `As an executor, use POST /gateway/tasks/${taskId}/submit-result to submit your work for review.`
        ), 403);
        return;
      }

      if (!res.ok) { textReply(reply, formatErrorResponse(`Complete failed (HTTP ${res.status})`), res.status); return; }

      deps.sessionTracker.untrack(taskId);
      log.info({ taskId, status: body.status }, 'Task completed via gateway proxy');
      textReply(reply, formatCompleteResponse(taskId, body.status || 'completed'));
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 7a. POST /gateway/tasks/:taskId/submit-result — executor submits result for review
  server.post<{ Params: { taskId: string } }>('/gateway/tasks/:taskId/submit-result', async (req, reply) => {
    const { taskId } = req.params;
    const body = autoTrack((req.body || {}) as Record<string, any>, taskId);
    try {
      const res = await proxyFetch(`${apiBase}/api/v1/tasks/${taskId}/submit-result`, {
        method: 'POST',
        headers: authHeaders(key, deps.clawteamBotId),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        const hint = res.status === 409
          ? `. The task may have already been submitted or its status changed. Check task status first.`
          : '';
        textReply(reply, formatErrorResponse(`Submit-result failed (HTTP ${res.status})${hint} ${errBody}`), res.status);
        return;
      }

      deps.sessionTracker.untrack(taskId);
      log.info({ taskId }, 'Task submitted for review via gateway proxy');
      textReply(reply, formatSubmitResultResponse(taskId));
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 7a2. POST /gateway/tasks/:taskId/approve — delegator approves pending_review task
  server.post<{ Params: { taskId: string } }>('/gateway/tasks/:taskId/approve', async (req, reply) => {
    const { taskId } = req.params;
    const body = autoTrack((req.body || {}) as Record<string, any>, taskId);
    try {
      const res = await proxyFetch(`${apiBase}/api/v1/tasks/${taskId}/approve`, {
        method: 'POST',
        headers: authHeaders(key, deps.clawteamBotId),
        body: JSON.stringify(body),
      });
      if (!res.ok) { textReply(reply, formatErrorResponse(`Approve failed (HTTP ${res.status})`), res.status); return; }

      log.info({ taskId }, 'Task approved via gateway proxy');
      textReply(reply, formatApproveResponse(taskId));
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 7a3. POST /gateway/tasks/:taskId/reject — delegator rejects pending_review task
  server.post<{ Params: { taskId: string } }>('/gateway/tasks/:taskId/reject', async (req, reply) => {
    const { taskId } = req.params;
    const body = autoTrack((req.body || {}) as Record<string, any>, taskId);
    try {
      const res = await proxyFetch(`${apiBase}/api/v1/tasks/${taskId}/reject`, {
        method: 'POST',
        headers: authHeaders(key, deps.clawteamBotId),
        body: JSON.stringify(body),
      });
      if (!res.ok) { textReply(reply, formatErrorResponse(`Reject failed (HTTP ${res.status})`), res.status); return; }

      log.info({ taskId, reason: body.reason }, 'Task rejected via gateway proxy');
      textReply(reply, formatRejectResponse(taskId, body.reason || 'Rejected'));
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 7b. POST /gateway/tasks/:taskId/need-human-input — mark as waiting_for_input
  server.post<{ Params: { taskId: string } }>('/gateway/tasks/:taskId/need-human-input', async (req, reply) => {
    const { taskId } = req.params;
    const body = autoTrack((req.body || {}) as Record<string, any>, taskId);
    try {
      const res = await proxyFetch(`${apiBase}/api/v1/tasks/${taskId}/need-human-input`, {
        method: 'POST',
        headers: authHeaders(key, deps.clawteamBotId),
        body: JSON.stringify(body),
      });
      if (!res.ok) { textReply(reply, formatErrorResponse(`Wait failed (HTTP ${res.status})`), res.status); return; }
      textReply(reply, `Task ${taskId} marked as waiting_for_input.`);
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 7c. POST /gateway/tasks/:taskId/resume — resume from waiting_for_input
  server.post<{ Params: { taskId: string } }>('/gateway/tasks/:taskId/resume', async (req, reply) => {
    const { taskId } = req.params;
    const body = autoTrack((req.body || {}) as Record<string, any>, taskId);
    try {
      const res = await proxyFetch(`${apiBase}/api/v1/tasks/${taskId}/resume`, {
        method: 'POST',
        headers: authHeaders(key, deps.clawteamBotId),
        body: JSON.stringify(body),
      });
      if (!res.ok) { textReply(reply, formatErrorResponse(`Resume failed (HTTP ${res.status})`), res.status); return; }
      textReply(reply, `Task ${taskId} resumed to processing.`);
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 8. POST /gateway/tasks/:taskId/cancel — cancel + untrack session
  server.post<{ Params: { taskId: string } }>('/gateway/tasks/:taskId/cancel', async (req, reply) => {
    const { taskId } = req.params;
    const body = autoTrack((req.body || {}) as Record<string, any>, taskId);
    try {
      const res = await proxyFetch(`${apiBase}/api/v1/tasks/all/${taskId}/cancel`, {
        method: 'POST',
        headers: authHeaders(key, deps.clawteamBotId),
        body: JSON.stringify({ reason: body.reason || 'Cancelled via gateway' }),
      });
      if (!res.ok) { textReply(reply, formatErrorResponse(`Cancel failed (HTTP ${res.status})`), res.status); return; }

      deps.sessionTracker.untrack(taskId);
      log.info({ taskId }, 'Task cancelled via gateway proxy');
      textReply(reply, formatCancelResponse(taskId));
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 9. GET /gateway/tasks/:taskId
  server.get<{ Params: { taskId: string } }>('/gateway/tasks/:taskId', async (req, reply) => {
    try {
      const res = await proxyFetch(`${apiBase}/api/v1/tasks/${req.params.taskId}`, {
        headers: authHeaders(key, deps.clawteamBotId),
      });
      if (!res.ok) { textReply(reply, formatErrorResponse(`HTTP ${res.status}`), res.status); return; }
      textReply(reply, formatTaskStatusResponse(unwrap(res.data)));
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 10. POST /gateway/messages/send
  server.post('/gateway/messages/send', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const rawBody = (req.body || {}) as Record<string, any>;
      const taskId = rawBody.taskId as string | undefined;
      const body = taskId ? autoTrack(rawBody, taskId) : rawBody;

      const res = await proxyFetch(`${apiBase}/api/v1/messages/send`, {
        method: 'POST',
        headers: authHeaders(key, deps.clawteamBotId),
        body: JSON.stringify(body),
      });
      if (!res.ok) { textReply(reply, formatErrorResponse(`Send failed (HTTP ${res.status})`), res.status); return; }
      textReply(reply, formatSendMessageResponse(unwrap(res.data)));
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 11. GET /gateway/messages/inbox
  server.get('/gateway/messages/inbox', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const res = await proxyFetch(`${apiBase}/api/v1/messages/inbox`, {
        headers: authHeaders(key, deps.clawteamBotId),
      });
      if (!res.ok) { textReply(reply, formatErrorResponse(`HTTP ${res.status}`), res.status); return; }
      textReply(reply, formatInboxResponse(unwrap(res.data)));
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });

  // 12. POST /gateway/messages/:messageId/ack
  server.post<{ Params: { messageId: string } }>('/gateway/messages/:messageId/ack', async (req, reply) => {
    try {
      const res = await proxyFetch(`${apiBase}/api/v1/messages/${req.params.messageId}/ack`, {
        method: 'POST',
        headers: authHeaders(key, deps.clawteamBotId),
        body: JSON.stringify(req.body || {}),
      });
      if (!res.ok) { textReply(reply, formatErrorResponse(`Ack failed (HTTP ${res.status})`), res.status); return; }
      textReply(reply, formatAckResponse(req.params.messageId));
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });
}
