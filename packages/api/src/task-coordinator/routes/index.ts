/**
 * Routes Index - Register all task coordinator routes
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { ApiResponse, Task, TaskCreateRequest, TaskCompleteRequest, PaginatedResponse } from '@clawteam/shared/types';
import type { ICapabilityRegistry } from '@clawteam/api/capability-registry';
import type { ITaskCoordinator } from '../interface';
import { isClawTeamError } from '@clawteam/api/common';
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
          const task = await coordinator.createTask(request.body, fromBotId);

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

    /** POST /:taskId/delegate — delegate task directly or sub-delegate by any participant */
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

          const hasSubTaskPrompt = !!(subTaskPrompt && typeof subTaskPrompt === 'string' && subTaskPrompt.trim());

          // Case 1: sub-delegate by any task participant (from/to bot).
          // Creates a child sub-task under current task and delegates it.
          if (hasSubTaskPrompt) {
            if (terminalStatuses.has(task.status)) {
              throw new InvalidTaskStateError(request.params.taskId, task.status, [
                'pending',
                'accepted',
                'processing',
                'waiting_for_input',
                'pending_review',
              ]);
            }

            const subTask = await coordinator.createTask(
              {
                prompt: subTaskPrompt.trim(),
                title: subTaskTitle,
                capability: subTaskCapability || task.capability,
                parameters: (subTaskParameters && typeof subTaskParameters === 'object')
                  ? subTaskParameters
                  : {},
                priority: subTaskPriority || task.priority,
                type: 'sub-task',
                parentTaskId: task.id,
              },
              fromBotId,
            );

            // If delegation fails, keep this sub-task pending for manual retry.
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

          // Case 2: direct delegate (no subTaskPrompt) keeps existing behavior:
          // only the original delegator can delegate a pre-created pending task.
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

        if (!sessionKey || !botId) {
          return reply.status(400).send({
            success: false,
            error: 'sessionKey and botId are required',
            traceId,
          });
        }

        if (callerBotId && botId !== callerBotId) {
          return reply.status(403).send({
            success: false,
            error: `botId mismatch: body.botId (${botId}) must equal caller botId (${callerBotId})`,
            traceId,
          });
        }

        if (!deps.db) {
          return reply.status(501).send({ success: false, error: 'Database not available', traceId });
        }

        try {
          const providedRole = role === 'sender' || role === 'executor' ? role : undefined;

          // Infer role from task participants as a safety net:
          // - botId === from_bot_id -> sender
          // - botId === to_bot_id   -> executor
          let inferredRole: 'sender' | 'executor' | undefined;
          const taskRoleResult = await deps.db.query(
            `SELECT from_bot_id, to_bot_id FROM tasks WHERE id = $1 LIMIT 1`,
            [request.params.taskId],
          );
          if (taskRoleResult.rowCount > 0) {
            const row = taskRoleResult.rows[0] as { from_bot_id: string; to_bot_id: string };
            if (row.from_bot_id === botId) inferredRole = 'sender';
            else if (row.to_bot_id === botId) inferredRole = 'executor';
          }

          let effectiveRole: 'sender' | 'executor' = providedRole ?? inferredRole ?? 'executor';
          if (providedRole && inferredRole && providedRole !== inferredRole) {
            request.log.warn(
              { taskId: request.params.taskId, botId, providedRole, inferredRole },
              'track-session role mismatch; using inferred role from task participants',
            );
            effectiveRole = inferredRole;
          }

          await deps.db.query(
            `INSERT INTO task_sessions (task_id, session_key, bot_id, role)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (task_id, bot_id)
             DO UPDATE SET session_key = EXCLUDED.session_key, role = EXCLUDED.role`,
            [request.params.taskId, sessionKey, botId, effectiveRole],
          );

          // Sync session key into the tasks table for dashboard visibility
          const column = effectiveRole === 'sender' ? 'sender_session_key' : 'executor_session_key';
          await deps.db.query(
            `UPDATE tasks SET ${column} = $1, updated_at = NOW() WHERE id = $2`,
            [sessionKey, request.params.taskId],
          );

          return reply.send({
            success: true,
            data: { taskId: request.params.taskId, sessionKey, botId },
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

    /** POST /all/:taskId/approve (public — dashboard admin approve) */
    fastify.post<{ Params: TaskParams; Body: { result?: any } }>(
      '/all/:taskId/approve',
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
          const body = (request.body || {}) as any;

          // Use provided result override, or copy submitted_result to result
          const result = await deps.db.query(
            `UPDATE tasks
             SET status = 'completed',
                 result = COALESCE($1::jsonb, submitted_result),
                 completed_at = NOW(),
                 updated_at = NOW()
             WHERE id = $2 AND status = 'pending_review'
             RETURNING id, status`,
            [body.result ? JSON.stringify(body.result) : null, taskId],
          );

          if (result.rowCount === 0) {
            return reply.status(404).send({
              success: false,
              error: { code: 'TASK_NOT_FOUND', message: `Task not found or not in pending_review: ${taskId}` },
              traceId,
            });
          }

          // Clean up Redis
          if (deps.redis) {
            await deps.redis.zrem(REDIS_KEYS.PROCESSING_SET, taskId);
            await deps.redis.del(`${REDIS_KEYS.TASK_CACHE}:${taskId}`);
          }

          return reply.send({
            success: true,
            data: { taskId, status: 'completed', approvedAt: new Date().toISOString() },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      }
    );

    /** POST /all/:taskId/reject (public — dashboard admin reject) */
    fastify.post<{ Params: TaskParams; Body: { reason?: string } }>(
      '/all/:taskId/reject',
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
          const reason = (request.body as any)?.reason || 'Rejected from dashboard';

          const result = await deps.db.query(
            `UPDATE tasks
             SET status = 'processing',
                 rejection_reason = $1,
                 updated_at = NOW()
             WHERE id = $2 AND status = 'pending_review'
             RETURNING id, status`,
            [reason, taskId],
          );

          if (result.rowCount === 0) {
            return reply.status(404).send({
              success: false,
              error: { code: 'TASK_NOT_FOUND', message: `Task not found or not in pending_review: ${taskId}` },
              traceId,
            });
          }

          return reply.send({
            success: true,
            data: { taskId, status: 'processing', rejectedAt: new Date().toISOString() },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
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
