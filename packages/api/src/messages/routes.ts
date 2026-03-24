/**
 * Message Routes - Bot 间消息收件箱 REST API
 *
 * Endpoints:
 * - POST /send              发送消息到目标 bot 收件箱
 * - GET  /inbox             拉取当前 bot 的收件箱消息
 * - POST /:messageId/ack    确认消息已读
 * - GET  /                  列出消息（DB 分页查询）
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { ICapabilityRegistry } from '@clawteam/api/capability-registry';
import type { DatabasePool } from '@clawteam/api/common';
import type { RedisClient } from '@clawteam/api/common';
import { isClawTeamError, ValidationError } from '@clawteam/api/common';
import { createAuthMiddleware } from '../task-coordinator/middleware/auth';
import { randomUUID } from 'crypto';

/** Redis key for bot inbox: LIST per priority, LPUSH on send, LRANGE on receive */
const INBOX_KEY_PREFIX = 'clawteam:inbox';

/** Visibility timeout for processing SET (seconds) — messages auto-become visible after this */
const PROCESSING_TTL_SECONDS = 300; // 5 minutes

/** Priority order for inbox polling (urgent first) */
const PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low'] as const;

export interface MessageRoutesDeps {
  db: DatabasePool;
  redis: RedisClient;
  registry?: ICapabilityRegistry;
  userRepo?: import('@clawteam/api/capability-registry').IUserRepository;
}

interface MessageParams {
  messageId: string;
}

interface InboxQuery {
  limit?: number;
}

interface MessageListQuery {
  role?: 'from' | 'to' | 'all';
  type?: string;
  status?: string;
  limit?: number;
  page?: number;
}

interface MessageAllQuery {
  taskId?: string;
  limit?: number;
}

interface SendMessageBody {
  toBotId: string;
  type?: 'direct_message' | 'task_notification' | 'broadcast' | 'system' | 'delegate_intent';
  contentType?: 'text' | 'json' | 'file' | 'image';
  content: string | Record<string, any>;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  taskId?: string;
}

function getBotId(request: FastifyRequest): string {
  if (request.bot?.id) return request.bot.id;
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
    error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal server error' },
    traceId,
  });
}

/** Remove a message from an inbox priority list by scanning for its messageId */
async function removeFromInboxList(
  redis: RedisClient,
  botId: string,
  priority: string,
  messageId: string,
): Promise<boolean> {
  const key = `${INBOX_KEY_PREFIX}:${botId}:${priority}`;
  const items = await redis.lrange(key, 0, -1);
  for (const item of items) {
    if (item.includes(messageId)) {
      const removed = await redis.lrem(key, 1, item);
      return removed > 0;
    }
  }
  return false;
}

export function createMessageRoutes(deps: MessageRoutesDeps): FastifyPluginAsync {
  const { db, redis, registry, userRepo } = deps;

  return async (fastify) => {
    if (!fastify.hasRequestDecorator('bot')) {
      fastify.decorateRequest('bot', undefined as any);
    }

    const authPreHandlers: preHandlerHookHandler[] = [];
    if (registry) {
      authPreHandlers.push(createAuthMiddleware(registry, userRepo));
    }

    fastify.setErrorHandler((error, _request, reply) => {
      if (isClawTeamError(error)) {
        return reply.status(error.statusCode).send({ success: false, error: error.toJSON() });
      }
      const err = error as Error;
      return reply.status(500).send({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal server error' },
      });
    });

    // ========================================================================
    // POST /send — 发送消息
    // ========================================================================
    fastify.post<{ Body: SendMessageBody }>(
      '/send',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const fromBotId = getBotId(request);

        try {
          const {
            toBotId,
            type = 'direct_message',
            contentType = 'text',
            content,
            priority = 'normal',
            taskId,
          } = request.body;

          if (!toBotId) {
            throw new ValidationError('toBotId is required');
          }
          if (fromBotId && fromBotId === toBotId) {
            throw new ValidationError('A bot cannot send messages to itself');
          }
          if (content === undefined || content === null) {
            throw new ValidationError('content is required');
          }

          // urgent priority is only allowed for task_notification
          if (priority === 'urgent' && type !== 'task_notification') {
            throw new ValidationError('urgent priority is only allowed for task_notification type');
          }

          const messageId = randomUUID();
          const now = new Date();

          // 1. Write to DB for persistence
          await db.query(
            `INSERT INTO messages (id, from_bot_id, to_bot_id, type, content_type, content, priority, status, task_id, trace_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'delivered', $8, $9, $10)`,
            [
              messageId,
              fromBotId,
              toBotId,
              type,
              contentType,
              JSON.stringify(typeof content === 'string' ? { text: content } : content),
              priority,
              taskId || null,
              traceId,
              now,
            ],
          );

          // 2. Push to Redis inbox for fast polling
          const inboxMessage = JSON.stringify({
            messageId,
            fromBotId,
            toBotId,
            type,
            contentType,
            content,
            priority,
            taskId: taskId || null,
            traceId,
            timestamp: now.toISOString(),
          });

          await redis.lpush(`${INBOX_KEY_PREFIX}:${toBotId}:${priority}`, inboxMessage);

          return reply.status(201).send({
            success: true,
            data: {
              messageId,
              status: 'delivered',
              timestamp: now.toISOString(),
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ========================================================================
    // GET /inbox — 拉取收件箱（从 Redis，非破坏性读取 + 可选 consume）
    // ========================================================================
    fastify.get<{ Querystring: InboxQuery }>(
      '/inbox',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = getBotId(request);

        try {
          const limit = Math.min(Math.max(request.query.limit || 10, 1), 50);
          const processingKey = `${INBOX_KEY_PREFIX}:${botId}:processing`;

          // Read the processing SET to filter out messages already being handled
          const processing = await redis.smembers(processingKey);
          const processingSet = new Set(processing);

          // LRANGE across priority queues: urgent → high → normal → low
          // Non-destructive read — messages stay in the list until ACK
          const messages: any[] = [];
          for (const p of PRIORITY_ORDER) {
            const key = `${INBOX_KEY_PREFIX}:${botId}:${p}`;
            const items = await redis.lrange(key, 0, -1);
            // items[0] = newest (LPUSH), tail = oldest → iterate from tail for FIFO
            for (let i = items.length - 1; i >= 0 && messages.length < limit; i--) {
              try {
                const parsed = JSON.parse(items[i]);
                if (!processingSet.has(parsed.messageId)) {
                  messages.push(parsed);
                }
              } catch {
                // Skip malformed messages
              }
            }
            if (messages.length >= limit) break;
          }

          // Mark returned messages as processing (visibility timeout)
          if (messages.length > 0) {
            const ids = messages.map((m: any) => m.messageId);
            await redis.sadd(processingKey, ...ids);
            await redis.expire(processingKey, PROCESSING_TTL_SECONDS);
          }

          // Count remaining: total in lists minus those in processing
          let totalInLists = 0;
          for (const p of PRIORITY_ORDER) {
            totalInLists += await redis.llen(`${INBOX_KEY_PREFIX}:${botId}:${p}`);
          }
          const processingCount = await redis.scard(processingKey);
          const remaining = Math.max(0, totalInLists - processingCount);

          return reply.send({
            success: true,
            data: {
              messages,
              count: messages.length,
              remaining,
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ========================================================================
    // GET /all — 公开端点，供 Dashboard 使用（无认证）
    // ========================================================================
    fastify.get<{ Querystring: MessageAllQuery }>(
      '/all',
      async (request, reply) => {
        const traceId = randomUUID();
        try {
          const limit = Math.min(Math.max(request.query.limit || 200, 1), 2000);
          const taskId = request.query.taskId?.trim();
          const params: unknown[] = [];
          let whereClause = '';
          if (taskId) {
            whereClause = 'WHERE task_id = $1';
            params.push(taskId);
          }
          params.push(limit);

          const result = await db.query(
            `SELECT id, from_bot_id, to_bot_id, type, content_type, content, priority, status, task_id, trace_id, created_at, read_at
             FROM messages
             ${whereClause}
             ORDER BY created_at DESC
             LIMIT $${params.length}`,
            params,
          );

          const messages = result.rows.map((row: any) => ({
            messageId: row.id,
            fromBotId: row.from_bot_id,
            toBotId: row.to_bot_id,
            type: row.type,
            contentType: row.content_type,
            content: row.content,
            priority: row.priority,
            status: row.status,
            taskId: row.task_id,
            traceId: row.trace_id,
            createdAt: row.created_at,
            readAt: row.read_at,
          }));

          return reply.send(messages);
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ========================================================================
    // POST /:messageId/ack — 确认消息已读
    // ========================================================================
    fastify.post<{ Params: MessageParams }>(
      '/:messageId/ack',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = getBotId(request);

        try {
          const { messageId } = request.params;

          const result = await db.query(
            `UPDATE messages SET status = 'read', read_at = NOW()
             WHERE id = $1 AND to_bot_id = $2 AND status = 'delivered'
             RETURNING id, priority`,
            [messageId, botId],
          );

          if (result.rowCount === 0) {
            return reply.status(404).send({
              success: false,
              error: { code: 'MESSAGE_NOT_FOUND', message: `Message not found or already read: ${messageId}` },
              traceId,
            });
          }

          // Remove from processing SET
          await redis.srem(`${INBOX_KEY_PREFIX}:${botId}:processing`, messageId);

          // Remove from inbox list
          const priority = result.rows[0].priority;
          const removed = await removeFromInboxList(redis, botId, priority, messageId);
          if (!removed) {
            // Fallback: scan all priority queues
            for (const p of PRIORITY_ORDER) {
              if (await removeFromInboxList(redis, botId, p, messageId)) break;
            }
          }

          return reply.send({
            success: true,
            data: { messageId, status: 'read', readAt: new Date().toISOString() },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );

    // ========================================================================
    // GET / — 列出消息（DB 分页查询）
    // ========================================================================
    fastify.get<{ Querystring: MessageListQuery }>(
      '/',
      { preHandler: authPreHandlers },
      async (request, reply) => {
        const traceId = randomUUID();
        const botId = getBotId(request);

        try {
          const role = request.query.role || 'to';
          const limit = Math.min(Math.max(request.query.limit || 20, 1), 100);
          const page = Math.max(request.query.page || 1, 1);
          const offset = (page - 1) * limit;

          let whereClause: string;
          const params: any[] = [];
          let paramIdx = 1;

          if (role === 'from') {
            whereClause = `from_bot_id = $${paramIdx++}`;
            params.push(botId);
          } else if (role === 'all') {
            whereClause = `(from_bot_id = $${paramIdx++} OR to_bot_id = $${paramIdx++})`;
            params.push(botId, botId);
          } else {
            whereClause = `to_bot_id = $${paramIdx++}`;
            params.push(botId);
          }

          if (request.query.type) {
            whereClause += ` AND type = $${paramIdx++}`;
            params.push(request.query.type);
          }
          if (request.query.status) {
            whereClause += ` AND status = $${paramIdx++}`;
            params.push(request.query.status);
          }

          const countResult = await db.query(
            `SELECT COUNT(*) as total FROM messages WHERE ${whereClause}`,
            params,
          );
          const total = parseInt(countResult.rows[0].total, 10);

          const dataParams = [...params, limit, offset];
          const result = await db.query(
            `SELECT id, from_bot_id, to_bot_id, type, content_type, content, priority, status, task_id, trace_id, created_at, read_at
             FROM messages
             WHERE ${whereClause}
             ORDER BY created_at DESC
             LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
            dataParams,
          );

          const messages = result.rows.map((row: any) => ({
            messageId: row.id,
            fromBotId: row.from_bot_id,
            toBotId: row.to_bot_id,
            type: row.type,
            contentType: row.content_type,
            content: row.content,
            priority: row.priority,
            status: row.status,
            taskId: row.task_id,
            traceId: row.trace_id,
            createdAt: row.created_at,
            readAt: row.read_at,
          }));

          return reply.send({
            success: true,
            data: {
              messages,
              total,
              page,
              pageSize: limit,
              hasMore: offset + messages.length < total,
            },
            traceId,
          });
        } catch (error) {
          return handleError(error, reply, traceId);
        }
      },
    );
  };
}
