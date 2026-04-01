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
  formatAckAlreadyReadResponse,
  formatErrorResponse,
  formatSubmitResultResponse,
  formatApproveResponse,
  formatRejectResponse,
  formatFilesListResponse,
  formatFileNodeResponse,
  formatFileDeleteResponse,
  formatFileDownloadResponse,
  formatDocRawResponse,
  formatPublishResponse,
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

function wantsJsonResponse(req: FastifyRequest): boolean {
  const accept = String(req.headers['accept'] || '');
  return accept.includes('application/json');
}

function sendSuccess(
  req: FastifyRequest,
  reply: FastifyReply,
  payload: any,
  textFormatter: (payload: any) => string,
  status = 200,
): void {
  if (wantsJsonResponse(req)) {
    reply.status(status).type('application/json').send({ success: true, data: payload });
    return;
  }
  textReply(reply, textFormatter(payload), status);
}

function sendJsonSuccess(reply: FastifyReply, payload: any, status = 200): void {
  reply.status(status).type('application/json').send({ success: true, data: payload });
}

function extractApiError(data: any): string {
  if (typeof data === 'string') return data;
  const code = typeof data?.error?.code === 'string' ? data.error.code : '';
  const message = typeof data?.error?.message === 'string' ? data.error.message : '';
  if (code && message) return `${code}: ${message}`;
  if (message) return message;
  return JSON.stringify(data);
}

function sendGatewayError(
  req: FastifyRequest,
  reply: FastifyReply,
  message: string,
  status = 500,
): void {
  if (wantsJsonResponse(req)) {
    reply.status(status).type('application/json').send({
      success: false,
      error: {
        message,
      },
    });
    return;
  }
  textReply(reply, formatErrorResponse(message), status);
}

function coerceRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {};
  return input as Record<string, unknown>;
}

function appendQuery(url: string, queryObj: Record<string, unknown>): string {
  const query = new URLSearchParams();
  Object.entries(queryObj).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string') query.set(key, value);
    else if (typeof value === 'number' || typeof value === 'boolean') query.set(key, String(value));
  });
  const qs = query.toString();
  return qs ? `${url}?${qs}` : url;
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
): Record<string, any> {
  const { sessionKey, sessionKeyRole, ...clean } = body;
  if (!sessionKey || !taskId) return body;

  deps.sessionTracker.track(taskId, sessionKey);
  deps.logger.info({ taskId, sessionKey, role: sessionKeyRole }, 'Auto-tracked session via sessionKey in request body');

  // Best-effort persist to API server
  const botId = deps.clawteamBotId;
  if (botId && deps.clawteamApiUrl && deps.clawteamApiKey) {
    const apiBase = deps.clawteamApiUrl.replace(/\/$/, '');
    proxyFetch(`${apiBase}/api/v1/tasks/${taskId}/track-session`, {
      method: 'POST',
      headers: authHeaders(deps.clawteamApiKey, botId),
      body: JSON.stringify({ sessionKey, botId, role: sessionKeyRole || 'executor' }),
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
  const autoTrack = (body: Record<string, any>, taskId: string) =>
    extractAndTrackSession(body, taskId, {
      sessionTracker: deps.sessionTracker,
      logger: log,
      clawteamBotId: deps.clawteamBotId,
      clawteamApiUrl: deps.clawteamApiUrl,
      clawteamApiKey: key,
    });

  const ensureTaskDelegatorCaller = async (taskId: string): Promise<{ ok: true } | { ok: false; status: number; message: string }> => {
    const taskRes = await proxyFetch(`${apiBase}/api/v1/tasks/${taskId}`, {
      headers: authHeaders(key, deps.clawteamBotId),
    });
    if (!taskRes.ok) {
      return {
        ok: false,
        status: taskRes.status,
        message: `Failed to validate task caller role (HTTP ${taskRes.status})`,
      };
    }
    const task = unwrap(taskRes.data);
    const fromBotId = task?.fromBotId || task?.from_bot_id;
    if (!deps.clawteamBotId || !fromBotId || deps.clawteamBotId !== fromBotId) {
      return {
        ok: false,
        status: 403,
        message: 'Only the delegator bot can publish task outputs via gateway.',
      };
    }
    return { ok: true };
  };

  const isTaskLinkedArtifact = (node: any, taskId: string): boolean => {
    if (!node || typeof node !== 'object') return false;
    const scope = String(node.scope || '');
    const scopeRef = String(node.scopeRef || node.scope_ref || '');
    if (scope === 'task' && scopeRef === taskId) return true;

    if (scope === 'team_shared') {
      const metadata = (node.metadata && typeof node.metadata === 'object')
        ? node.metadata as Record<string, unknown>
        : {};
      if (String(metadata.taskId || '') === taskId) return true;
    }
    return false;
  };

  const validateSubmitArtifacts = async (taskId: string, artifactNodeIds: string[]): Promise<{ ok: true } | { ok: false; status: number; message: string }> => {
    for (const nodeId of artifactNodeIds) {
      const nodeRes = await proxyFetch(`${apiBase}/api/v1/files/${nodeId}`, {
        headers: authHeaders(key, deps.clawteamBotId),
      });
      if (!nodeRes.ok) {
        return {
          ok: false,
          status: nodeRes.status,
          message: `artifactNodeId not accessible: ${nodeId} (HTTP ${nodeRes.status})`,
        };
      }
      const node = unwrap(nodeRes.data)?.node;
      if (!isTaskLinkedArtifact(node, taskId)) {
        return {
          ok: false,
          status: 400,
          message: `artifactNodeId ${nodeId} is not linked to task ${taskId} (expected task scope or published-from-task metadata).`,
        };
      }
    }
    return { ok: true };
  };

  const validateTaskLinkedNode = async (taskId: string, nodeId: string): Promise<{ ok: true } | { ok: false; status: number; message: string }> => {
    const nodeRes = await proxyFetch(`${apiBase}/api/v1/files/${nodeId}`, {
      headers: authHeaders(key, deps.clawteamBotId),
    });
    if (!nodeRes.ok) {
      return {
        ok: false,
        status: nodeRes.status,
        message: `nodeId not accessible: ${nodeId} (HTTP ${nodeRes.status})`,
      };
    }
    const node = unwrap(nodeRes.data)?.node;
    if (!isTaskLinkedArtifact(node, taskId)) {
      return {
        ok: false,
        status: 400,
        message: `nodeId ${nodeId} is not linked to task ${taskId}.`,
      };
    }
    return { ok: true };
  };

  const filesApiUrl = (pathSuffix: string, queryObj?: Record<string, unknown>): string => {
    const baseUrl = `${apiBase}/api/v1/files${pathSuffix}`;
    return appendQuery(baseUrl, queryObj || {});
  };

  const callFilesApi = async (
    pathSuffix: string,
    opts: {
      method?: string;
      body?: Record<string, unknown>;
      query?: Record<string, unknown>;
    } = {},
  ): Promise<{ ok: boolean; status: number; data: any }> => {
    const url = filesApiUrl(pathSuffix, opts.query);
    return proxyFetch(url, {
      method: opts.method || 'GET',
      headers: authHeaders(key, deps.clawteamBotId),
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
  };

  const withTaskScope = (taskId: string, raw: unknown): Record<string, unknown> => {
    const body = coerceRecord(raw);
    return {
      ...body,
      taskId,
      scope: 'task',
      scopeRef: taskId,
    };
  };

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
    const body = autoTrack((req.body || {}) as Record<string, any>, taskId);
    const localBotId = deps.clawteamBotId;

    if (!body.toBotId || typeof body.toBotId !== 'string') {
      textReply(reply, formatErrorResponse('toBotId is required.'), 400);
      return;
    }

    // fromBotId, if provided by caller, must match local gateway bot identity.
    if (localBotId && body.fromBotId && body.fromBotId !== localBotId) {
      log.warn({ taskId, bodyFromBotId: body.fromBotId, localBotId }, 'Blocked delegate with mismatched fromBotId');
      textReply(reply, formatErrorResponse(`fromBotId mismatch: expected ${localBotId}, got ${body.fromBotId}`), 403);
      return;
    }
    // Normalize sender identity for downstream API/audit logic.
    if (localBotId) {
      body.fromBotId = localBotId;
    }

    // Block self-delegation
    if (localBotId && body.toBotId === localBotId) {
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

      // Track session — but don't overwrite existing valid tracking
      // (provider-agnostic: any existing key is preserved, regardless of format)
      const executorSessionKey = body.executorSessionKey as string | undefined;
      if (executorSessionKey) {
        const existing = deps.sessionTracker.getSessionForTask(taskId);
        if (!existing) {
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
    const submitted = body.result;
    if (submitted === undefined || submitted === null) {
      textReply(
        reply,
        formatErrorResponse(
          `submit-result requires a final deliverable in body.result. ` +
          `Use DM or /need-human-input for intermediate progress/questions.`
        ),
        400,
      );
      return;
    }
    if (typeof submitted !== 'object' || Array.isArray(submitted)) {
      textReply(
        reply,
        formatErrorResponse(
          `submit-result body.result must be an object and include artifactNodeIds. ` +
          `Example: {"result":{"summary":"...","artifactNodeIds":["<nodeId>"]}}`
        ),
        400,
      );
      return;
    }

    const artifactRaw = (submitted as Record<string, unknown>).artifactNodeIds;
    if (!Array.isArray(artifactRaw) || artifactRaw.length === 0) {
      textReply(
        reply,
        formatErrorResponse(
          `submit-result requires result.artifactNodeIds (non-empty array). ` +
          `Upload/create artifacts under /gateway/tasks/${taskId}/files/* first, then reference node IDs in submit-result.`
        ),
        400,
      );
      return;
    }

    const artifactNodeIds = artifactRaw
      .filter((v) => typeof v === 'string')
      .map((v) => (v as string).trim())
      .filter((v) => v.length > 0);
    if (artifactNodeIds.length !== artifactRaw.length) {
      textReply(reply, formatErrorResponse('artifactNodeIds must contain only non-empty string node IDs.'), 400);
      return;
    }

    try {
      const artifactValidation = await validateSubmitArtifacts(taskId, artifactNodeIds);
      if (!artifactValidation.ok) {
        textReply(reply, formatErrorResponse(artifactValidation.message), artifactValidation.status);
        return;
      }

      body.result = {
        ...(submitted as Record<string, unknown>),
        artifactNodeIds,
      };

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
      if (!res.ok) {
        const apiError = (typeof res.data === 'object' && res.data?.error) ? res.data.error : null;
        const currentStatus = apiError?.details?.currentStatus as string | undefined;
        const errorMsg = typeof apiError?.message === 'string' ? apiError.message : '';

        // Idempotent behavior: if the task is already waiting_for_input, treat as success.
        if (res.status === 409 && currentStatus === 'waiting_for_input') {
          textReply(reply, `Task ${taskId} is already waiting_for_input. Human input request is still pending.`);
          return;
        }

        // Auto-correction for common conflict:
        // executor submitted too early (pending_review), then delegator asks for human input.
        // If caller is delegator, auto-reject back to processing and retry need-human-input.
        if (res.status === 409 && currentStatus === 'pending_review') {
          try {
            const taskRes = await proxyFetch(`${apiBase}/api/v1/tasks/${taskId}`, {
              headers: authHeaders(key, deps.clawteamBotId),
            });
            const task = taskRes.ok ? unwrap(taskRes.data) : null;
            const fromBotId = (task?.fromBotId || task?.from_bot_id) as string | undefined;
            const isDelegatorCaller = !!deps.clawteamBotId && !!fromBotId && deps.clawteamBotId === fromBotId;

            if (!isDelegatorCaller) {
              textReply(
                reply,
                formatErrorResponse(
                  `Wait failed (HTTP 409): task is currently "pending_review". ` +
                  `After submit-result, use DM for follow-up; only the delegator can reject and reopen execution.`
                ),
                409,
              );
              return;
            }

            const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
            const autoRejectReason = reason
              ? `Auto-correction: delegator requested more info before final review (${reason})`
              : 'Auto-correction: delegator requested more info before final review';
            const rejectRes = await proxyFetch(`${apiBase}/api/v1/tasks/${taskId}/reject`, {
              method: 'POST',
              headers: authHeaders(key, deps.clawteamBotId),
              body: JSON.stringify({ reason: autoRejectReason }),
            });

            if (!rejectRes.ok) {
              const rejectError = (typeof rejectRes.data === 'object' && rejectRes.data?.error) ? rejectRes.data.error : null;
              const rejectStatus = rejectError?.details?.currentStatus as string | undefined;
              const rejectRecoverable = rejectRes.status === 409
                && (rejectStatus === 'processing' || rejectStatus === 'waiting_for_input');
              if (rejectRecoverable) {
                log.info({ taskId, rejectStatus }, 'Auto-correction reject already applied by concurrent actor');
              } else {
              textReply(
                reply,
                formatErrorResponse(
                  `Wait failed (HTTP 409): task is "pending_review", and auto-reject recovery failed (HTTP ${rejectRes.status}).`
                ),
                rejectRes.status,
              );
              return;
              }
            }

            const retryRes = await proxyFetch(`${apiBase}/api/v1/tasks/${taskId}/need-human-input`, {
              method: 'POST',
              headers: authHeaders(key, deps.clawteamBotId),
              body: JSON.stringify(body),
            });

            if (retryRes.ok) {
              textReply(
                reply,
                `Task ${taskId} auto-corrected (pending_review -> processing -> waiting_for_input).`,
              );
              return;
            }

            const retryError = (typeof retryRes.data === 'object' && retryRes.data?.error) ? retryRes.data.error : null;
            const retryStatus = retryError?.details?.currentStatus as string | undefined;
            if (retryRes.status === 409 && retryStatus === 'waiting_for_input') {
              textReply(reply, `Task ${taskId} is already waiting_for_input. Human input request is still pending.`);
              return;
            }

            textReply(
              reply,
              formatErrorResponse(`Wait failed after auto-correction (HTTP ${retryRes.status})`),
              retryRes.status,
            );
            return;
          } catch (err) {
            textReply(reply, formatErrorResponse((err as Error).message), 502);
            return;
          }
        }

        if (res.status === 409 && currentStatus === 'pending') {
          textReply(
            reply,
            formatErrorResponse(
              `Wait failed (HTTP 409): task is currently "pending". ` +
              `The executor must accept the task first (POST /gateway/tasks/${taskId}/accept) before /need-human-input can transition it to waiting_for_input.`
            ),
            409,
          );
          return;
        }

        if (res.status === 409 && currentStatus) {
          textReply(
            reply,
            formatErrorResponse(`Wait failed (HTTP 409): task is currently "${currentStatus}"`),
            409,
          );
          return;
        }

        const suffix = errorMsg ? `: ${errorMsg}` : '';
        textReply(reply, formatErrorResponse(`Wait failed (HTTP ${res.status})${suffix}`), res.status);
        return;
      }
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

  // 9b. File Service proxy routes (ACL endpoints intentionally not exposed)
  server.get('/gateway/files', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = coerceRecord((req as FastifyRequest & { query?: unknown }).query);
      const res = await callFilesApi('', { query });
      if (!res.ok) {
        sendGatewayError(req, reply, `List files failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      sendSuccess(req, reply, unwrap(res.data), formatFilesListResponse);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.post('/gateway/files/folders', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = coerceRecord(req.body);
      const res = await callFilesApi('/folders', { method: 'POST', body });
      if (!res.ok) {
        sendGatewayError(req, reply, `Create folder failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      const payload = unwrap(res.data);
      sendSuccess(req, reply, payload, (p) => formatFileNodeResponse('Create folder', p?.node), res.status);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.post('/gateway/files/docs', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = coerceRecord(req.body);
      const res = await callFilesApi('/docs', { method: 'POST', body });
      if (!res.ok) {
        sendGatewayError(req, reply, `Create doc failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      const payload = unwrap(res.data);
      sendSuccess(req, reply, payload, (p) => formatFileNodeResponse('Create doc', p?.node), res.status);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.get<{ Params: { docId: string } }>('/gateway/files/docs/:docId/raw', async (req, reply) => {
    try {
      const res = await callFilesApi(`/docs/${req.params.docId}/raw`);
      if (!res.ok) {
        sendGatewayError(req, reply, `Get doc raw failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      sendSuccess(req, reply, unwrap(res.data), formatDocRawResponse);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.put<{ Params: { docId: string } }>('/gateway/files/docs/:docId/raw', async (req, reply) => {
    try {
      const body = coerceRecord(req.body);
      const res = await callFilesApi(`/docs/${req.params.docId}/raw`, { method: 'PUT', body });
      if (!res.ok) {
        sendGatewayError(req, reply, `Update doc raw failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      sendSuccess(req, reply, unwrap(res.data), formatDocRawResponse, res.status);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.post('/gateway/files/upload', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = coerceRecord(req.body);
      const res = await callFilesApi('/upload', { method: 'POST', body });
      if (!res.ok) {
        sendGatewayError(req, reply, `Upload failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      const payload = unwrap(res.data);
      sendSuccess(req, reply, payload, (p) => formatFileNodeResponse('Upload file', p?.node), res.status);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.get<{ Params: { nodeId: string } }>('/gateway/files/download/:nodeId', async (req, reply) => {
    try {
      const query = coerceRecord((req as FastifyRequest & { query?: unknown }).query);
      const requestedFormat = typeof query.format === 'string' ? query.format : undefined;
      const format = requestedFormat ?? 'json';
      const nodeId = req.params.nodeId;

      if (format === 'binary') {
        const upstream = await fetch(filesApiUrl(`/download/${nodeId}`, { format: 'binary' }), {
          headers: authHeaders(key, deps.clawteamBotId),
        });
        if (!upstream.ok) {
          const raw = await upstream.text();
          let parsed: any = raw;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          sendGatewayError(req, reply, `Download failed (HTTP ${upstream.status}): ${extractApiError(parsed)}`, upstream.status);
          return;
        }
        const contentType = upstream.headers.get('content-type');
        const contentLength = upstream.headers.get('content-length');
        const contentDisposition = upstream.headers.get('content-disposition');
        if (contentType) reply.header('content-type', contentType);
        if (contentLength) reply.header('content-length', contentLength);
        if (contentDisposition) reply.header('content-disposition', contentDisposition);
        const bytes = await upstream.arrayBuffer();
        reply.status(200).send(Buffer.from(bytes));
        return;
      }

      const res = await callFilesApi(`/download/${nodeId}`, { query: { ...query, format: 'json' } });
      if (!res.ok) {
        sendGatewayError(req, reply, `Download failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      // Force JSON only when caller explicitly requested format=json.
      if (requestedFormat === 'json') {
        sendJsonSuccess(reply, unwrap(res.data), res.status);
      } else {
        sendSuccess(req, reply, unwrap(res.data), formatFileDownloadResponse, res.status);
      }
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.post('/gateway/files/move', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = coerceRecord(req.body);
      const res = await callFilesApi('/move', { method: 'POST', body });
      if (!res.ok) {
        sendGatewayError(req, reply, `Move failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      const payload = unwrap(res.data);
      sendSuccess(req, reply, payload, (p) => formatFileNodeResponse('Move resource', p?.node), res.status);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.post('/gateway/files/copy', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = coerceRecord(req.body);
      const res = await callFilesApi('/copy', { method: 'POST', body });
      if (!res.ok) {
        sendGatewayError(req, reply, `Copy failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      const payload = unwrap(res.data);
      sendSuccess(req, reply, payload, (p) => formatFileNodeResponse('Copy resource', p?.node), res.status);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.post('/gateway/files/publish', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = coerceRecord(req.body);
      const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
      if (taskId) {
        const publishGuard = await ensureTaskDelegatorCaller(taskId);
        if (!publishGuard.ok) {
          sendGatewayError(req, reply, publishGuard.message, publishGuard.status);
          return;
        }
      }
      const res = await callFilesApi('/publish', { method: 'POST', body });
      if (!res.ok) {
        sendGatewayError(req, reply, `Publish failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      sendSuccess(req, reply, unwrap(res.data), formatPublishResponse, res.status);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.delete<{ Params: { nodeId: string } }>('/gateway/files/:nodeId', async (req, reply) => {
    try {
      const res = await callFilesApi(`/${req.params.nodeId}`, { method: 'DELETE' });
      if (!res.ok) {
        sendGatewayError(req, reply, `Delete failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      const payload = unwrap(res.data);
      sendSuccess(req, reply, payload, (p) => formatFileDeleteResponse(req.params.nodeId, Number(p?.deletedCount || 0)));
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.get<{ Params: { nodeId: string } }>('/gateway/files/:nodeId', async (req, reply) => {
    try {
      const res = await callFilesApi(`/${req.params.nodeId}`);
      if (!res.ok) {
        sendGatewayError(req, reply, `Get node failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      const payload = unwrap(res.data);
      sendSuccess(req, reply, payload, (p) => formatFileNodeResponse('Get node', p?.node));
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  // 9c. Task-scoped file shortcuts
  server.get<{ Params: { taskId: string } }>('/gateway/tasks/:taskId/files', async (req, reply) => {
    const { taskId } = req.params;
    try {
      const query = coerceRecord((req as FastifyRequest & { query?: unknown }).query);
      const res = await callFilesApi('', {
        query: {
          ...query,
          scope: 'task',
          scopeRef: taskId,
        },
      });
      if (!res.ok) {
        sendGatewayError(req, reply, `List task files failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      sendSuccess(req, reply, unwrap(res.data), formatFilesListResponse);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.post<{ Params: { taskId: string } }>('/gateway/tasks/:taskId/files/folders', async (req, reply) => {
    const { taskId } = req.params;
    try {
      const body = withTaskScope(taskId, req.body);
      const res = await callFilesApi('/folders', { method: 'POST', body });
      if (!res.ok) {
        sendGatewayError(req, reply, `Create task folder failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      const payload = unwrap(res.data);
      sendSuccess(req, reply, payload, (p) => formatFileNodeResponse('Create task folder', p?.node), res.status);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.post<{ Params: { taskId: string } }>('/gateway/tasks/:taskId/files/docs', async (req, reply) => {
    const { taskId } = req.params;
    try {
      const body = withTaskScope(taskId, req.body);
      const res = await callFilesApi('/docs', { method: 'POST', body });
      if (!res.ok) {
        sendGatewayError(req, reply, `Create task doc failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      const payload = unwrap(res.data);
      sendSuccess(req, reply, payload, (p) => formatFileNodeResponse('Create task doc', p?.node), res.status);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.get<{ Params: { taskId: string; docId: string } }>('/gateway/tasks/:taskId/files/docs/:docId/raw', async (req, reply) => {
    const { taskId, docId } = req.params;
    try {
      const nodeCheck = await validateTaskLinkedNode(taskId, docId);
      if (!nodeCheck.ok) {
        sendGatewayError(req, reply, nodeCheck.message, nodeCheck.status);
        return;
      }
      const res = await callFilesApi(`/docs/${docId}/raw`);
      if (!res.ok) {
        sendGatewayError(req, reply, `Get task doc raw failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      sendSuccess(req, reply, unwrap(res.data), formatDocRawResponse);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.put<{ Params: { taskId: string; docId: string } }>('/gateway/tasks/:taskId/files/docs/:docId/raw', async (req, reply) => {
    const { taskId, docId } = req.params;
    try {
      const nodeCheck = await validateTaskLinkedNode(taskId, docId);
      if (!nodeCheck.ok) {
        sendGatewayError(req, reply, nodeCheck.message, nodeCheck.status);
        return;
      }
      const body = coerceRecord(req.body);
      const res = await callFilesApi(`/docs/${docId}/raw`, { method: 'PUT', body });
      if (!res.ok) {
        sendGatewayError(req, reply, `Update task doc raw failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      sendSuccess(req, reply, unwrap(res.data), formatDocRawResponse, res.status);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.post<{ Params: { taskId: string } }>('/gateway/tasks/:taskId/files/upload', async (req, reply) => {
    const { taskId } = req.params;
    try {
      const body = withTaskScope(taskId, req.body);
      const res = await callFilesApi('/upload', { method: 'POST', body });
      if (!res.ok) {
        sendGatewayError(req, reply, `Upload task file failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      const payload = unwrap(res.data);
      sendSuccess(req, reply, payload, (p) => formatFileNodeResponse('Upload task file', p?.node), res.status);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.get<{ Params: { taskId: string; nodeId: string } }>('/gateway/tasks/:taskId/files/download/:nodeId', async (req, reply) => {
    const { taskId, nodeId } = req.params;
    try {
      const nodeCheck = await validateTaskLinkedNode(taskId, nodeId);
      if (!nodeCheck.ok) {
        sendGatewayError(req, reply, nodeCheck.message, nodeCheck.status);
        return;
      }
      const query = coerceRecord((req as FastifyRequest & { query?: unknown }).query);
      const requestedFormat = typeof query.format === 'string' ? query.format : undefined;
      const format = requestedFormat ?? 'json';

      if (format === 'binary') {
        const upstream = await fetch(filesApiUrl(`/download/${nodeId}`, { format: 'binary' }), {
          headers: authHeaders(key, deps.clawteamBotId),
        });
        if (!upstream.ok) {
          const raw = await upstream.text();
          let parsed: any = raw;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          sendGatewayError(req, reply, `Task file download failed (HTTP ${upstream.status}): ${extractApiError(parsed)}`, upstream.status);
          return;
        }
        const contentType = upstream.headers.get('content-type');
        const contentLength = upstream.headers.get('content-length');
        const contentDisposition = upstream.headers.get('content-disposition');
        if (contentType) reply.header('content-type', contentType);
        if (contentLength) reply.header('content-length', contentLength);
        if (contentDisposition) reply.header('content-disposition', contentDisposition);
        const bytes = await upstream.arrayBuffer();
        reply.status(200).send(Buffer.from(bytes));
        return;
      }

      const res = await callFilesApi(`/download/${nodeId}`, { query: { ...query, format: 'json' } });
      if (!res.ok) {
        sendGatewayError(req, reply, `Task file download failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      // Force JSON only when caller explicitly requested format=json.
      if (requestedFormat === 'json') {
        sendJsonSuccess(reply, unwrap(res.data), res.status);
      } else {
        sendSuccess(req, reply, unwrap(res.data), formatFileDownloadResponse, res.status);
      }
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.post<{ Params: { taskId: string } }>('/gateway/tasks/:taskId/files/move', async (req, reply) => {
    const { taskId } = req.params;
    try {
      const body = withTaskScope(taskId, req.body);
      const res = await callFilesApi('/move', { method: 'POST', body });
      if (!res.ok) {
        sendGatewayError(req, reply, `Move task file failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      const payload = unwrap(res.data);
      sendSuccess(req, reply, payload, (p) => formatFileNodeResponse('Move task resource', p?.node), res.status);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.post<{ Params: { taskId: string } }>('/gateway/tasks/:taskId/files/copy', async (req, reply) => {
    const { taskId } = req.params;
    try {
      const body = withTaskScope(taskId, req.body);
      const res = await callFilesApi('/copy', { method: 'POST', body });
      if (!res.ok) {
        sendGatewayError(req, reply, `Copy task file failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      const payload = unwrap(res.data);
      sendSuccess(req, reply, payload, (p) => formatFileNodeResponse('Copy task resource', p?.node), res.status);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.post<{ Params: { taskId: string } }>('/gateway/tasks/:taskId/files/publish', async (req, reply) => {
    const { taskId } = req.params;
    try {
      const publishGuard = await ensureTaskDelegatorCaller(taskId);
      if (!publishGuard.ok) {
        sendGatewayError(req, reply, publishGuard.message, publishGuard.status);
        return;
      }
      const body = {
        ...coerceRecord(req.body),
        taskId,
      };
      const res = await callFilesApi('/publish', { method: 'POST', body });
      if (!res.ok) {
        sendGatewayError(req, reply, `Publish task artifact failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      sendSuccess(req, reply, unwrap(res.data), formatPublishResponse, res.status);
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.delete<{ Params: { taskId: string; nodeId: string } }>('/gateway/tasks/:taskId/files/:nodeId', async (req, reply) => {
    const { taskId, nodeId } = req.params;
    try {
      const nodeCheck = await validateTaskLinkedNode(taskId, nodeId);
      if (!nodeCheck.ok) {
        sendGatewayError(req, reply, nodeCheck.message, nodeCheck.status);
        return;
      }
      const res = await callFilesApi(`/${nodeId}`, { method: 'DELETE' });
      if (!res.ok) {
        sendGatewayError(req, reply, `Delete task file failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      const payload = unwrap(res.data);
      sendSuccess(req, reply, payload, (p) => formatFileDeleteResponse(nodeId, Number(p?.deletedCount || 0)));
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
    }
  });

  server.get<{ Params: { taskId: string; nodeId: string } }>('/gateway/tasks/:taskId/files/:nodeId', async (req, reply) => {
    const { taskId, nodeId } = req.params;
    try {
      const nodeCheck = await validateTaskLinkedNode(taskId, nodeId);
      if (!nodeCheck.ok) {
        sendGatewayError(req, reply, nodeCheck.message, nodeCheck.status);
        return;
      }
      const res = await callFilesApi(`/${nodeId}`);
      if (!res.ok) {
        sendGatewayError(req, reply, `Get task file node failed (HTTP ${res.status}): ${extractApiError(res.data)}`, res.status);
        return;
      }
      const payload = unwrap(res.data);
      sendSuccess(req, reply, payload, (p) => formatFileNodeResponse('Get task node', p?.node));
    } catch (err) {
      sendGatewayError(req, reply, (err as Error).message, 502);
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
      if (!res.ok) {
        const errCode = typeof res.data?.error?.code === 'string' ? res.data.error.code : '';
        // Idempotent ACK behavior: treat "already read" as success.
        if (res.status === 404 && errCode === 'MESSAGE_NOT_FOUND') {
          const payload = { messageId: req.params.messageId, status: 'already_read' };
          if (wantsJsonResponse(req)) {
            sendJsonSuccess(reply, payload, 200);
          } else {
            textReply(reply, formatAckAlreadyReadResponse(req.params.messageId));
          }
          return;
        }
        textReply(reply, formatErrorResponse(`Ack failed (HTTP ${res.status})`), res.status);
        return;
      }
      const payload = unwrap(res.data);
      if (payload?.status === 'already_read') {
        if (wantsJsonResponse(req)) {
          sendJsonSuccess(reply, payload, 200);
        } else {
          textReply(reply, formatAckAlreadyReadResponse(req.params.messageId));
        }
        return;
      }
      textReply(reply, formatAckResponse(req.params.messageId));
    } catch (err) {
      textReply(reply, formatErrorResponse((err as Error).message), 502);
    }
  });
}
