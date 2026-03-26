/**
 * Routes Index - Register all task coordinator routes
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { ApiResponse, Task, TaskCreateRequest, TaskCompleteRequest, PaginatedResponse } from '@clawteam/shared/types';
import type { ICapabilityRegistry } from '@clawteam/api/capability-registry';
import type { ITaskCoordinator } from '../interface';
import { isClawTeamError, ValidationError } from '@clawteam/api/common';
import { createAuthMiddleware } from '../middleware/auth';
import { REDIS_KEYS, PRIORITY_ORDER } from '../constants';
import { randomUUID } from 'crypto';
import { InvalidTaskStateError, TaskNotFoundError, UnauthorizedTaskError } from '../errors';

export interface TaskRoutesDeps {
  coordinator: ITaskCoordinator;
  registry?: ICapabilityRegistry;
  userRepo?: import('@clawteam/api/capability-registry').IUserRepository;
  db?: any; // Database pool for listing all tasks
  redis?: any; // Redis client for queue cleanup on public cancel
}

interface TaskParams {
  taskId: string;
}

interface PollQuery {
  botId?: string;
  limit?: number;
}

interface TaskListQuery {
  botId?: string;
  role?: 'from' | 'to' | 'all';
  status?: string;
  page?: number;
  limit?: number;
}

interface CancelBody {
  reason: string;
}

/**
 * Extract botId from authenticated bot or X-Bot-Id header (Phase 1 fallback).
 */
function getBotId(request: FastifyRequest): string {
  // Auth middleware sets request.bot
  if (request.bot?.id) return request.bot.id;

  // Phase 1 fallback: X-Bot-Id header or botId query param
  const headerBotId = request.headers['x-bot-id'];
  if (typeof headerBotId === 'string') return headerBotId;

  const queryBotId = (request.query as Record<string, unknown>).botId;
  if (typeof queryBotId === 'string') return queryBotId;

  return '';
}

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, any>;
}

function normalizeBotIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return Array.from(new Set(ids));
}

function normalizeParticipantBots(value: unknown): Array<{ botId: string; botName?: string; botOwner?: string }> {
  if (!Array.isArray(value)) return [];
  const next: Array<{ botId: string; botName?: string; botOwner?: string }> = [];
  const seen = new Set<string>();
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const botId = typeof rec.botId === 'string' ? rec.botId.trim() : '';
    if (!botId || seen.has(botId)) continue;
    seen.add(botId);
    const botName = typeof rec.botName === 'string' && rec.botName.trim() ? rec.botName.trim() : undefined;
    const botOwner = typeof rec.botOwner === 'string' && rec.botOwner.trim() ? rec.botOwner.trim() : undefined;
    next.push({ botId, ...(botName ? { botName } : {}), ...(botOwner ? { botOwner } : {}) });
  }
  return next;
}

function extractParticipantBotIdsFromParameters(parameters: unknown): string[] {
  const top = asRecord(parameters);
  if (!top) return [];

  const collaboration = asRecord(top.collaboration);
  const delegateIntent = asRecord(top.delegateIntent);

  const ids = new Set<string>();
  for (const id of normalizeBotIdList(top.participantBotIds)) ids.add(id);
  for (const id of normalizeBotIdList(collaboration?.participantBotIds)) ids.add(id);
  for (const id of normalizeBotIdList(delegateIntent?.participantBotIds)) ids.add(id);

  const collabBots = normalizeParticipantBots(collaboration?.participantBots);
  const intentBots = normalizeParticipantBots(delegateIntent?.participantBots);
  for (const item of collabBots) ids.add(item.botId);
  for (const item of intentBots) ids.add(item.botId);

  return Array.from(ids);
}

function readStrictParticipantScope(parameters: unknown): boolean {
  const top = asRecord(parameters);
  const collaboration = asRecord(top?.collaboration);
  if (typeof collaboration?.strictParticipantScope === 'boolean') {
    return collaboration.strictParticipantScope;
  }
  return extractParticipantBotIdsFromParameters(parameters).length > 0;
}

function normalizeCreateParameters(parameters: unknown, fromBotId: string): Record<string, any> {
  const top = asRecord(parameters);
  if (!top) return {};

  const next: Record<string, any> = { ...top };
  const collaboration = asRecord(next.collaboration) || {};
  const delegateIntent = asRecord(next.delegateIntent) || {};

  const participantBotIds = extractParticipantBotIdsFromParameters(next).filter((id) => id !== fromBotId);
  if (participantBotIds.length === 0) return next;

  const participantBots = normalizeParticipantBots(collaboration.participantBots).length > 0
    ? normalizeParticipantBots(collaboration.participantBots)
    : normalizeParticipantBots(delegateIntent.participantBots);

  next.collaboration = {
    ...collaboration,
    participantBotIds,
    ...(participantBots.length > 0 ? { participantBots } : {}),
    strictParticipantScope:
      typeof collaboration.strictParticipantScope === 'boolean'
        ? collaboration.strictParticipantScope
        : true,
  };

  if (Object.keys(delegateIntent).length > 0) {
    next.delegateIntent = {
      ...delegateIntent,
      participantBotIds,
      ...(participantBots.length > 0 ? { participantBots } : {}),
    };
  }

  return next;
}

function inheritCollaborationParameters(
  parentParameters: unknown,
  childParameters: Record<string, unknown>,
): Record<string, unknown> {
  const parentTop = asRecord(parentParameters);
  if (!parentTop) return childParameters;

  const parentParticipantBotIds = extractParticipantBotIdsFromParameters(parentTop);
  if (parentParticipantBotIds.length === 0) return childParameters;

  const next: Record<string, unknown> = { ...childParameters };
  const childTop = asRecord(next) || {};
  const parentCollaboration = asRecord(parentTop.collaboration) || {};
  const parentDelegateIntent = asRecord(parentTop.delegateIntent) || {};
  const childCollaboration = asRecord(childTop.collaboration) || {};
  const childDelegateIntent = asRecord(childTop.delegateIntent) || {};

  const childParticipantBotIds = extractParticipantBotIdsFromParameters(childTop);
  const mergedParticipantBotIds = Array.from(new Set([...parentParticipantBotIds, ...childParticipantBotIds]));

  const participantBots = normalizeParticipantBots(childCollaboration.participantBots).length > 0
    ? normalizeParticipantBots(childCollaboration.participantBots)
    : normalizeParticipantBots(parentCollaboration.participantBots).length > 0
      ? normalizeParticipantBots(parentCollaboration.participantBots)
      : normalizeParticipantBots(parentDelegateIntent.participantBots);

  next.collaboration = {
    ...parentCollaboration,
    ...childCollaboration,
    participantBotIds: mergedParticipantBotIds,
    ...(participantBots.length > 0 ? { participantBots } : {}),
    strictParticipantScope:
      typeof childCollaboration.strictParticipantScope === 'boolean'
        ? childCollaboration.strictParticipantScope
        : typeof parentCollaboration.strictParticipantScope === 'boolean'
          ? parentCollaboration.strictParticipantScope
          : true,
  };

  if (Object.keys(parentDelegateIntent).length > 0 || Object.keys(childDelegateIntent).length > 0) {
    next.delegateIntent = {
      ...parentDelegateIntent,
      ...childDelegateIntent,
      participantBotIds: mergedParticipantBotIds,
      ...(participantBots.length > 0 ? { participantBots } : {}),
    };
  }

  return next;
}

async function isTaskParticipantBot(db: any, taskId: string, botId: string): Promise<boolean> {
  try {
    const graphRes = await db.query(
      `SELECT task_id
         FROM task_participants
        WHERE task_id = $1
          AND bot_id = $2
        LIMIT 1`,
      [taskId, botId],
    );
    if ((graphRes.rowCount ?? 0) > 0) return true;
  } catch {
    // Backward-compatible fallback for pre-migration DB.
  }

  const fallbackRes = await db.query(
    `SELECT id
       FROM tasks
      WHERE id = $1
        AND (from_bot_id = $2 OR to_bot_id = $2)
      LIMIT 1`,
    [taskId, botId],
  );
  return (fallbackRes.rowCount ?? 0) > 0;
}

function handleError(error: unknown, reply: FastifyReply, traceId: string): FastifyReply {
  if (isClawTeamError(error)) {
    return reply.status(error.statusCode).send({
      success: false,
      error: error.toJSON(),
      traceId,
    });
  }

  const err = error as Error;
  return reply.status(500).send({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: err.message || 'Internal server error',
    },
    traceId,
  });
}

/**
 * Create the main routes plugin that registers all task coordinator routes.
 *
 * When `registry` is provided in deps, API Key authentication is enforced
 * on protected endpoints. Without `registry`, falls back to X-Bot-Id header
 * (Phase 1 compatibility).
 *
 * Routes:
 * - POST /create             - Create a task record (protected)
 * - POST /:taskId/delegate   - Delegate a pre-created task (protected)
 * - GET  /pending             - Poll pending tasks (protected)
 * - POST /:taskId/accept     - Accept a task: pending → processing (protected)
 * - POST /:taskId/complete   - Complete a task (protected)
 * - POST /:taskId/cancel     - Cancel a task (protected)
 * - POST /:taskId/resume     - Unified resume: waiting_for_input or completed/failed/timeout (protected)
 * - GET  /:taskId             - Get task details (protected)
 * - GET  /                    - List tasks for a bot (protected)
 */
export function createTaskRoutes(deps: TaskRoutesDeps): FastifyPluginAsync {
  const { coordinator, registry, userRepo } = deps;

  return async (fastify) => {
    // Decorate request with bot property (for auth middleware)
    if (!fastify.hasRequestDecorator('bot')) {
      fastify.decorateRequest('bot', undefined as any);
    }

    // Build auth preHandler list (empty when no registry = Phase 1 compat)
    const authPreHandlers: preHandlerHookHandler[] = [];
    if (registry) {
      authPreHandlers.push(createAuthMiddleware(registry, userRepo));
    }

    // Error handler for ClawTeamError (handles auth errors thrown by preHandler)
    fastify.setErrorHandler((error, _request, reply) => {
      if (isClawTeamError(error)) {
        return reply.status(error.statusCode).send({
          success: false,
          error: error.toJSON(),
        });
      }

      const err = error as Error;
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: err.message || 'Internal server error',
        },
      });
    });

    // === Protected lifecycle routes ===

    /** POST /create — Create a task record without enqueuing or notifying */
    fastify.post<{ Body: TaskCreateRequest }>(
      '/create',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const fromBotId = getBotId(request);

        try {
          const normalizedBody: TaskCreateRequest = {
            ...request.body,
            parameters: normalizeCreateParameters(request.body?.parameters, fromBotId),
          };

          const participantBotIds = extractParticipantBotIdsFromParameters(normalizedBody.parameters);
          if (registry && participantBotIds.length > 0) {
            for (const participantBotId of participantBotIds) {
              const bot = await registry.getBot(participantBotId);
              if (!bot) {
                throw new ValidationError(`participant bot not found: ${participantBotId}`);
              }
            }
          }

          const task = await coordinator.createTask(normalizedBody, fromBotId);

          return reply.status(201).send({
            success: true,
            data: {
              taskId: task.id,
              ...task,
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** POST /:taskId/delegate-intent — Register a delegate intent (inbox-driven) */
    fastify.post<{ Params: TaskParams }>(
      '/:taskId/delegate-intent',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const fromBotId = getBotId(request);

        try {
          await coordinator.registerDelegateIntent(request.params.taskId, fromBotId);

          return reply.send({
            success: true,
            data: {
              taskId: request.params.taskId,
              message: 'delegate_intent queued',
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** POST /:taskId/delegate — direct delegate or sub-delegate (child task) */
    fastify.post<{
      Params: TaskParams;
      Body: {
        toBotId: string;
        subTaskPrompt?: string;
        subTaskTitle?: string;
        subTaskCapability?: string;
        subTaskParameters?: Record<string, unknown>;
        subTaskPriority?: 'low' | 'normal' | 'high' | 'urgent';
      };
    }>(
      '/:taskId/delegate',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const fromBotId = getBotId(request);
        const {
          toBotId,
          subTaskPrompt,
          subTaskTitle,
          subTaskCapability,
          subTaskParameters,
          subTaskPriority,
        } = (request.body || {}) as any;

        if (!toBotId) {
          return reply.status(400).send({ success: false, error: 'toBotId is required', traceId });
        }

        try {
          const task = await coordinator.getTask(request.params.taskId, fromBotId);
          if (!task) {
            throw new TaskNotFoundError(request.params.taskId);
          }

          const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'timeout']);
          const hasSubTaskPrompt = typeof subTaskPrompt === 'string' && subTaskPrompt.trim().length > 0;
          const participantBotIds = extractParticipantBotIdsFromParameters(task.parameters);
          const strictParticipantScope = readStrictParticipantScope(task.parameters);

          if (strictParticipantScope && participantBotIds.length > 0 && !participantBotIds.includes(toBotId)) {
            throw new ValidationError(
              `toBotId ${toBotId} is outside collaboration participant roster: ${participantBotIds.join(', ')}`,
            );
          }

          // Sub-delegate: any task participant can create a child task and delegate it.
          if (hasSubTaskPrompt) {
            const isParticipant = deps.db
              ? await isTaskParticipantBot(deps.db, task.id, fromBotId)
              : (task.fromBotId === fromBotId || task.toBotId === fromBotId);
            if (!isParticipant) {
              throw new UnauthorizedTaskError(request.params.taskId, fromBotId);
            }
            if (terminalStatuses.has(task.status)) {
              throw new InvalidTaskStateError(request.params.taskId, task.status, [
                'pending',
                'accepted',
                'processing',
                'waiting_for_input',
                'pending_review',
              ]);
            }

            const rawChildParams = (subTaskParameters && typeof subTaskParameters === 'object')
              ? (subTaskParameters as Record<string, unknown>)
              : {};
            const inheritedChildParams = inheritCollaborationParameters(task.parameters, rawChildParams);

            const subTask = await coordinator.createTask(
              {
                prompt: subTaskPrompt.trim(),
                title: subTaskTitle,
                capability: subTaskCapability || task.capability,
                parameters: inheritedChildParams,
                priority: subTaskPriority || task.priority,
                type: 'sub-task',
                parentTaskId: task.id,
              },
              fromBotId,
            );

            await coordinator.delegate(subTask.id, toBotId);

            return reply.send({
              success: true,
              data: {
                taskId: subTask.id,
                parentTaskId: task.id,
                toBotId,
                delegationMode: 'sub-task',
                delegatedAt: new Date().toISOString(),
              },
              traceId,
            });
          }

          // Direct delegate: only original delegator can delegate a pending task.
          if (task.fromBotId !== fromBotId) {
            throw new UnauthorizedTaskError(request.params.taskId, fromBotId);
          }
          if (task.status !== 'pending') {
            throw new InvalidTaskStateError(request.params.taskId, task.status, ['pending']);
          }

          await coordinator.delegate(request.params.taskId, toBotId);

          return reply.send({
            success: true,
            data: {
              taskId: request.params.taskId,
              parentTaskId: task.parentTaskId || null,
              toBotId,
              delegationMode: 'direct',
              delegatedAt: new Date().toISOString(),
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** GET /pending */
    fastify.get<{ Querystring: PollQuery }>(
      '/pending',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = getBotId(request);

        try {
          const tasks = await coordinator.poll(botId, request.query.limit);

          const response: ApiResponse<{ tasks: Task[]; hasMore: boolean }> = {
            success: true,
            data: { tasks, hasMore: false },
            traceId,
          };

          return reply.send(response);
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** POST /:taskId/accept */
    fastify.post<{ Params: TaskParams }>(
      '/:taskId/accept',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = getBotId(request);
        const { executorSessionKey } = (request.body || {}) as any;

        try {
          await coordinator.accept(request.params.taskId, botId, executorSessionKey || undefined);

          return reply.send({
            success: true,
            data: {
              taskId: request.params.taskId,
              status: 'processing',
              acceptedAt: new Date().toISOString(),
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** POST /:taskId/complete */
    fastify.post<{ Params: TaskParams; Body: TaskCompleteRequest }>(
      '/:taskId/complete',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = getBotId(request);

        try {
          await coordinator.complete(request.params.taskId, request.body, botId);

          return reply.send({
            success: true,
            data: {
              taskId: request.params.taskId,
              status: request.body.status,
              completedAt: new Date().toISOString(),
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** POST /:taskId/submit-result — Executor submits result for review */
    fastify.post<{ Params: TaskParams; Body: { result?: any } }>(
      '/:taskId/submit-result',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = getBotId(request);
        const body = (request.body || {}) as any;
        const submitted = body.result;
        const emptyObject = typeof submitted === 'object'
          && submitted !== null
          && !Array.isArray(submitted)
          && Object.keys(submitted as Record<string, unknown>).length === 0;
        const emptyString = typeof submitted === 'string' && submitted.trim().length === 0;
        if (submitted === undefined || submitted === null || emptyObject || emptyString) {
          return reply.status(400).send({
            success: false,
            error: {
              code: 'INVALID_SUBMITTED_RESULT',
              message: 'submit-result requires a final non-empty result. Use DM or need-human-input for intermediate updates.',
            },
            traceId,
          });
        }

        try {
          await coordinator.submitResult(request.params.taskId, body.result, botId);

          return reply.send({
            success: true,
            data: {
              taskId: request.params.taskId,
              status: 'pending_review',
              submittedAt: new Date().toISOString(),
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** POST /:taskId/approve — Delegator approves pending_review task */
    fastify.post<{ Params: TaskParams; Body: { result?: any } }>(
      '/:taskId/approve',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = getBotId(request);
        const body = (request.body || {}) as any;

        try {
          await coordinator.approve(request.params.taskId, botId, body.result);

          return reply.send({
            success: true,
            data: {
              taskId: request.params.taskId,
              status: 'completed',
              approvedAt: new Date().toISOString(),
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** POST /:taskId/reject — Delegator rejects pending_review task */
    fastify.post<{ Params: TaskParams; Body: { reason?: string } }>(
      '/:taskId/reject',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = getBotId(request);
        const body = (request.body || {}) as any;

        try {
          await coordinator.reject(request.params.taskId, botId, body.reason || 'Rejected');

          return reply.send({
            success: true,
            data: {
              taskId: request.params.taskId,
              status: 'processing',
              rejectedAt: new Date().toISOString(),
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** POST /:taskId/request-changes — Delegator requests revision feedback */
    fastify.post<{ Params: TaskParams; Body: { feedback?: string; reason?: string } }>(
      '/:taskId/request-changes',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = getBotId(request);
        const body = (request.body || {}) as any;
        const rawFeedback = typeof body.feedback === 'string'
          ? body.feedback
          : (typeof body.reason === 'string' ? body.reason : '');
        const feedback = rawFeedback.trim() || 'Please revise and resubmit.';

        try {
          await coordinator.requestChanges(request.params.taskId, botId, feedback);

          return reply.send({
            success: true,
            data: {
              taskId: request.params.taskId,
              status: 'processing',
              reviewAction: 'changes_requested',
              feedback,
              requestedAt: new Date().toISOString(),
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** POST /:taskId/cancel */
    fastify.post<{ Params: TaskParams; Body: CancelBody }>(
      '/:taskId/cancel',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = getBotId(request);

        try {
          await coordinator.cancel(request.params.taskId, request.body.reason, botId);

          return reply.send({
            success: true,
            data: {
              taskId: request.params.taskId,
              status: 'cancelled',
              cancelledAt: new Date().toISOString(),
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** POST /:taskId/need-human-input — Mark task as waiting for human input */
    fastify.post<{ Params: TaskParams; Body: { reason?: string; targetBotId?: string } }>(
      '/:taskId/need-human-input',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = getBotId(request);

        try {
          const reason = (request.body as any)?.reason || 'Waiting for human input';
          const targetBotId = (request.body as any)?.targetBotId;
          await coordinator.waitForInput(request.params.taskId, botId, reason, targetBotId);

          return reply.send({
            success: true,
            data: {
              taskId: request.params.taskId,
              status: 'waiting_for_input',
              reason,
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** POST /:taskId/resume — Unified resume: waiting_for_input or completed/failed/timeout */
    fastify.post<{ Params: TaskParams; Body: { input?: string; humanInput?: string; targetBotId?: string } }>(
      '/:taskId/resume',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = getBotId(request);
        const body = (request.body || {}) as any;
        // Accept both 'input' (new unified) and 'humanInput' (legacy) fields
        const input = body.input ?? body.humanInput ?? body.prompt;
        const targetBotId = body.targetBotId;

        try {
          await coordinator.resume(request.params.taskId, botId, input, targetBotId);

          return reply.send({
            success: true,
            data: {
              taskId: request.params.taskId,
              status: 'processing',
              resumedAt: new Date().toISOString(),
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** POST /:taskId/reset — Reset accepted/processing task back to pending */
    fastify.post<{ Params: TaskParams }>(
      '/:taskId/reset',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = getBotId(request);

        try {
          await coordinator.reset(request.params.taskId, botId);

          return reply.send({
            success: true,
            data: {
              taskId: request.params.taskId,
              status: 'pending',
              resetAt: new Date().toISOString(),
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** POST /:taskId/heartbeat — Session status heartbeat from TaskRouter */
    fastify.post<{
      Params: TaskParams;
      Body: {
        sessionKey: string;
        sessionStatus: string;
        lastActivityAt: string | null;
        details: Record<string, unknown>;
      };
    }>(
      '/:taskId/heartbeat',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();

        try {
          const { sessionKey, sessionStatus, lastActivityAt, details } = request.body;
          const taskId = request.params.taskId;

          if (deps.db) {
            await deps.db.query(
              `UPDATE tasks SET
                last_heartbeat_at = NOW(),
                session_status = $1,
                heartbeat_details = $2
              WHERE id = $3`,
              [sessionStatus, JSON.stringify({ sessionKey, lastActivityAt, ...details }), taskId],
            );
          }

          return reply.send({
            success: true,
            data: { taskId, sessionStatus, receivedAt: new Date().toISOString() },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    // === Query routes ===

    /** PATCH /:taskId/session-key — Update task session keys (gateway sync) */
    fastify.patch<{ Params: TaskParams }>('/:taskId/session-key', async (request, reply) => {
      const { senderSessionKey, executorSessionKey } = (request.body || {}) as any;

      const sets: string[] = [];
      const params: any[] = [];
      if (senderSessionKey) {
        params.push(senderSessionKey);
        sets.push(`sender_session_key = $${params.length}`);
      }
      if (executorSessionKey) {
        params.push(executorSessionKey);
        sets.push(`executor_session_key = $${params.length}`);
      }
      if (sets.length === 0) {
        return reply.status(400).send({ success: false, error: 'No session keys provided' });
      }

      if (!deps.db) {
        return reply.status(501).send({ success: false, error: 'Database not available' });
      }

      params.push(request.params.taskId);
      await deps.db.query(
        `UPDATE tasks SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
        params
      );

      return { success: true, data: { taskId: request.params.taskId } };
    });

    /** POST /:taskId/track-session — Persist a session mapping for a task */
    fastify.post<{ Params: TaskParams }>(
      '/:taskId/track-session',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const { sessionKey, botId, role } = (request.body || {}) as any;
        const callerBotId = getBotId(request);

        if (!sessionKey) {
          return reply.status(400).send({
            success: false,
            error: 'sessionKey is required',
            traceId,
          });
        }
        if (!callerBotId) {
          return reply.status(400).send({
            success: false,
            error: 'bot identity is required (auth or X-Bot-Id)',
            traceId,
          });
        }
        if (botId && botId !== callerBotId) {
          return reply.status(403).send({
            success: false,
            error: `botId mismatch: caller=${callerBotId}, body.botId=${botId}`,
            traceId,
          });
        }

        if (!deps.db) {
          return reply.status(501).send({ success: false, error: 'Database not available', traceId });
        }

        try {
          const taskResult = await deps.db.query(
            'SELECT from_bot_id, to_bot_id FROM tasks WHERE id = $1',
            [request.params.taskId],
          );
          if (taskResult.rows.length === 0) {
            throw new TaskNotFoundError(request.params.taskId);
          }

          const row = taskResult.rows[0];
          let inferredRole: 'sender' | 'executor' | null = null;
          if (row.from_bot_id === callerBotId) {
            inferredRole = 'sender';
          } else if (row.to_bot_id === callerBotId) {
            inferredRole = 'executor';
          }

          if (!inferredRole) {
            throw new UnauthorizedTaskError(request.params.taskId, callerBotId);
          }

          const requestedRole = role === 'sender' || role === 'executor' ? role : undefined;
          const effectiveRole = inferredRole;

          if (requestedRole && requestedRole !== inferredRole) {
            request.log.warn(
              { taskId: request.params.taskId, callerBotId, requestedRole, inferredRole },
              'track-session role mismatch, using inferred role',
            );
          }

          await deps.db.query(
            `INSERT INTO task_sessions (task_id, session_key, bot_id, role)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (task_id, bot_id)
             DO UPDATE SET session_key = EXCLUDED.session_key, role = EXCLUDED.role`,
            [request.params.taskId, sessionKey, callerBotId, effectiveRole],
          );

          // Sync session key into the tasks table for dashboard visibility
          const column = effectiveRole === 'sender' ? 'sender_session_key' : 'executor_session_key';
          await deps.db.query(
            `UPDATE tasks SET ${column} = $1, updated_at = NOW() WHERE id = $2`,
            [sessionKey, request.params.taskId],
          );

          return reply.send({
            success: true,
            data: {
              taskId: request.params.taskId,
              sessionKey,
              botId: callerBotId,
              role: effectiveRole,
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    /** GET /:taskId/sessions — Get all session mappings for a task */
    fastify.get<{ Params: TaskParams }>(
      '/:taskId/sessions',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();

        if (!deps.db) {
          return reply.status(501).send({ success: false, error: 'Database not available', traceId });
        }

        try {
          const result = await deps.db.query(
            `SELECT task_id, session_key, bot_id, role, created_at
             FROM task_sessions WHERE task_id = $1`,
            [request.params.taskId],
          );

          const sessions = result.rows.map((r: any) => ({
            taskId: r.task_id,
            sessionKey: r.session_key,
            botId: r.bot_id,
            role: r.role,
            createdAt: r.created_at,
          }));

          return reply.send({ success: true, data: { sessions }, traceId });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    /** GET /sessions-by-bot?botId=xxx — Get all session mappings for a bot (used by gateway bootstrap) */
    fastify.get<{ Querystring: { botId?: string } }>(
      '/sessions-by-bot',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = request.query.botId || getBotId(request);

        if (!botId) {
          return reply.status(400).send({
            success: false,
            error: 'botId is required (query param or X-Bot-Id header)',
            traceId,
          });
        }

        if (!deps.db) {
          return reply.status(501).send({ success: false, error: 'Database not available', traceId });
        }

        try {
          const result = await deps.db.query(
            `SELECT task_id, session_key, bot_id, role, created_at
             FROM task_sessions WHERE bot_id = $1`,
            [botId],
          );

          const sessions = result.rows.map((r: any) => ({
            taskId: r.task_id,
            sessionKey: r.session_key,
            botId: r.bot_id,
            role: r.role,
            createdAt: r.created_at,
          }));

          return reply.send({ success: true, data: { sessions }, traceId });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    /** POST /all/:taskId/cancel (public — dashboard admin cancel) */
    fastify.post<{ Params: TaskParams; Body: CancelBody }>(
      '/all/:taskId/cancel',
      async (request, reply) => {
        const traceId = randomUUID();

        if (!deps.db) {
          return reply.status(501).send({
            success: false,
            error: { code: 'NOT_IMPLEMENTED', message: 'Database not available' },
            traceId,
          });
        }

        try {
          const taskId = request.params.taskId;
          const reason = request.body?.reason ?? 'Cancelled from dashboard';

          const result = await deps.db.query(
            `UPDATE tasks SET status = 'cancelled', error = $1, completed_at = NOW(), updated_at = NOW()
             WHERE id = $2 AND status IN ('pending', 'accepted', 'processing', 'waiting_for_input', 'pending_review')
             RETURNING id, status, to_bot_id`,
            [JSON.stringify({ code: 'CANCELLED', message: reason }), taskId],
          );

          if (result.rowCount === 0) {
            return reply.status(404).send({
              success: false,
              error: { code: 'TASK_NOT_FOUND', message: `Task not found or not cancellable: ${taskId}` },
              traceId,
            });
          }

          // Clean up Redis queues so the task is not re-polled or re-processed
          if (deps.redis) {
            const toBotId = result.rows[0].to_bot_id;
            // Remove from priority queues
            for (const priority of PRIORITY_ORDER) {
              await deps.redis.lrem(`${REDIS_KEYS.TASK_QUEUE}:${toBotId}:${priority}`, 0, taskId);
            }
            // Remove from processing ZSET
            await deps.redis.zrem(REDIS_KEYS.PROCESSING_SET, taskId);
            // Clear task cache
            await deps.redis.del(`${REDIS_KEYS.TASK_CACHE}:${taskId}`);
          }

          return reply.send({
            success: true,
            data: { taskId, status: 'cancelled', cancelledAt: new Date().toISOString() },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** POST /all/:taskId/approve (disabled — enforce delegator-bot proxy review) */
    fastify.post<{ Params: TaskParams; Body: { result?: any } }>(
      '/all/:taskId/approve',
      async (_request, reply) => {
        const traceId = randomUUID();
        return reply.status(403).send({
          success: false,
          error: {
            code: 'DELEGATOR_PROXY_REQUIRED',
            message: 'Direct dashboard approval is disabled. Use the delegator bot review path (/api/v1/tasks/:taskId/approve or /gateway/tasks/:taskId/approve).',
          },
          traceId,
        });
      }
    );

    /** POST /all/:taskId/reject (disabled — enforce delegator-bot proxy review) */
    fastify.post<{ Params: TaskParams; Body: { reason?: string } }>(
      '/all/:taskId/reject',
      async (_request, reply) => {
        const traceId = randomUUID();
        return reply.status(403).send({
          success: false,
          error: {
            code: 'DELEGATOR_PROXY_REQUIRED',
            message: 'Direct dashboard rejection is disabled. Use the delegator bot review path (/api/v1/tasks/:taskId/reject or /gateway/tasks/:taskId/reject).',
          },
          traceId,
        });
      }
    );

    /** POST /all/:taskId/request-changes (disabled — enforce delegator-bot proxy review) */
    fastify.post<{ Params: TaskParams; Body: { feedback?: string; reason?: string } }>(
      '/all/:taskId/request-changes',
      async (_request, reply) => {
        const traceId = randomUUID();
        return reply.status(403).send({
          success: false,
          error: {
            code: 'DELEGATOR_PROXY_REQUIRED',
            message: 'Direct dashboard request-changes is disabled. Use the delegator bot review path (/api/v1/tasks/:taskId/request-changes or /gateway/tasks/:taskId/request-changes).',
          },
          traceId,
        });
      }
    );

    /** GET /all (public — list all tasks for dashboard) */
    fastify.get(
      '/all',
      async (request, reply) => {
        const traceId = randomUUID();

        if (deps.db) {
          try {
            const result = await deps.db.query(
              'SELECT id, from_bot_id, to_bot_id, prompt, capability, parameters, status, priority, type, title, parent_task_id, sender_session_key, executor_session_key, result, error, created_at, accepted_at, started_at, completed_at, updated_at, timeout_seconds, retry_count, max_retries, submitted_result, submitted_at, rejection_reason FROM tasks ORDER BY created_at DESC LIMIT 100'
            );

            const tasks = result.rows.map((row: any) => ({
              id: row.id,
              fromBotId: row.from_bot_id,
              toBotId: row.to_bot_id,
              prompt: row.prompt || undefined,
              capability: row.capability || 'general',
              parameters: row.parameters,
              status: row.status,
              priority: row.priority,
              type: row.type,
              title: row.title || undefined,
              parentTaskId: row.parent_task_id,
              senderSessionKey: row.sender_session_key,
              executorSessionKey: row.executor_session_key,
              result: row.result,
              error: row.error,
              createdAt: row.created_at,
              acceptedAt: row.accepted_at,
              startedAt: row.started_at,
              completedAt: row.completed_at,
              updatedAt: row.updated_at,
              timeoutSeconds: row.timeout_seconds,
              retryCount: row.retry_count,
              maxRetries: row.max_retries,
              submittedResult: row.submitted_result,
              submittedAt: row.submitted_at,
              rejectionReason: row.rejection_reason,
            }));

            return reply.send(tasks);
          } catch (error) {
            return handleError(error, reply, traceId);
          }
        }

        return reply.send([]);
      }
    );

    /** GET /:taskId (protected — requires auth to check permission) */
    fastify.get<{ Params: TaskParams }>(
      '/:taskId',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = getBotId(request);

        try {
          const task = await coordinator.getTask(request.params.taskId, botId);

          if (!task) {
            return reply.status(404).send({
              success: false,
              error: {
                code: 'TASK_NOT_FOUND',
                message: `Task not found: ${request.params.taskId}`,
              },
              traceId,
            });
          }

          return reply.send({
            success: true,
            data: task,
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** GET / (protected — list tasks for authenticated bot) */
    fastify.get<{ Querystring: TaskListQuery }>(
      '/',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = getBotId(request);

        // If no botId (unauthenticated) and db is available, return all tasks
        if (!botId && deps.db) {
          const result = await deps.db.query(
            'SELECT id, from_bot_id, to_bot_id, prompt, capability, parameters, status, priority, type, parent_task_id, sender_session_key, executor_session_key, result, error, created_at, accepted_at, started_at, completed_at, updated_at, timeout_seconds, retry_count, max_retries FROM tasks ORDER BY created_at DESC LIMIT 100'
          );

          const tasks = result.rows.map((row: any) => ({
            id: row.id,
            fromBotId: row.from_bot_id,
            toBotId: row.to_bot_id,
            prompt: row.prompt || undefined,
            capability: row.capability || 'general',
            parameters: row.parameters,
            status: row.status,
            priority: row.priority,
            type: row.type,
            parentTaskId: row.parent_task_id,
            senderSessionKey: row.sender_session_key,
            executorSessionKey: row.executor_session_key,
            result: row.result,
            error: row.error,
            createdAt: row.created_at,
            acceptedAt: row.accepted_at,
            startedAt: row.started_at,
            completedAt: row.completed_at,
            updatedAt: row.updated_at,
            timeoutSeconds: row.timeout_seconds,
            retryCount: row.retry_count,
            maxRetries: row.max_retries,
          }));

          return reply.send({
            success: true,
            data: { items: tasks, total: tasks.length, page: 1, limit: 100, hasMore: false },
            traceId,
          });
        }

        try {
          const statusFilter = request.query.status
            ? (request.query.status as string).split(',').map((s) => s.trim()) as any[]
            : undefined;

          const result = await coordinator.getTasksByBot(botId, {
            role: request.query.role,
            status: statusFilter,
            page: request.query.page ? Number(request.query.page) : undefined,
            limit: request.query.limit ? Number(request.query.limit) : undefined,
          });

          return reply.send({
            success: true,
            data: result,
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );
  };
}
