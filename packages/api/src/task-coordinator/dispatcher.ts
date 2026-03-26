/**
 * Task Dispatcher - Task creation, validation, and queue management
 */

import type { Task, TaskCreateRequest } from '@clawteam/shared/types';
import type { ICapabilityRegistry } from '@clawteam/api/capability-registry';
import type { IMessageBus } from '@clawteam/api/message-bus';
import type { DatabasePool, RedisClient, Logger } from '@clawteam/api/common';
import { ValidationError } from '@clawteam/api/common';
import { InvalidTaskStateError, TaskNotFoundError, QueueFullError } from './errors';
import { taskRowToTask, type TaskRow } from './types';
import {
  MAX_QUEUE_SIZE,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_MAX_RETRIES,
  PRIORITY_ORDER,
  REDIS_KEYS,
  CACHE_TTL_BUFFER_SECONDS,
} from './constants';
import { randomUUID } from 'crypto';
import { redisFallbackTotal } from './metrics';

export interface TaskDispatcherDeps {
  db: DatabasePool;
  redis: RedisClient;
  registry: ICapabilityRegistry;
  messageBus: IMessageBus;
  logger: Logger;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeBotIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return Array.from(new Set(ids));
}

function extractParticipantBotIds(parameters: unknown): string[] {
  const top = asRecord(parameters);
  if (!top) return [];
  const collaboration = asRecord(top.collaboration);
  const delegateIntent = asRecord(top.delegateIntent);
  const ids = new Set<string>();
  for (const id of normalizeBotIdList(top.participantBotIds)) ids.add(id);
  for (const id of normalizeBotIdList(collaboration?.participantBotIds)) ids.add(id);
  for (const id of normalizeBotIdList(delegateIntent?.participantBotIds)) ids.add(id);
  return Array.from(ids);
}

export class TaskDispatcher {
  private readonly db: DatabasePool;
  private readonly redis: RedisClient;
  private readonly registry: ICapabilityRegistry;
  private readonly messageBus: IMessageBus;
  private readonly logger: Logger;

  constructor(deps: TaskDispatcherDeps) {
    this.db = deps.db;
    this.redis = deps.redis;
    this.registry = deps.registry;
    this.messageBus = deps.messageBus;
    this.logger = deps.logger;
  }

  private async upsertTaskParticipant(
    taskId: string,
    botId: string,
    role: 'delegator' | 'executor' | 'participant',
    addedByBotId?: string,
  ): Promise<void> {
    if (!taskId || !botId) return;

    try {
      await this.db.query(
        `INSERT INTO task_participants (task_id, bot_id, role, added_by_bot_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (task_id, bot_id)
         DO UPDATE SET
           role = CASE
             WHEN task_participants.role = 'delegator' THEN task_participants.role
             WHEN EXCLUDED.role = 'delegator' THEN EXCLUDED.role
             WHEN EXCLUDED.role = 'executor' THEN EXCLUDED.role
             ELSE task_participants.role
           END,
           added_by_bot_id = COALESCE(task_participants.added_by_bot_id, EXCLUDED.added_by_bot_id)`,
        [taskId, botId, role, addedByBotId || null],
      );
    } catch (error) {
      this.logger.warn('task_participants sync skipped (likely pre-migration)', {
        taskId,
        botId,
        role,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Delegate a pre-created task to a target bot.
   * Sets to_bot_id, enqueues to Redis, and writes task_notification to inbox.
   * The task must already exist in DB (created via createTaskRecord).
   */
  async delegate(taskId: string, toBotId: string): Promise<void> {
    if (!toBotId) {
      throw new ValidationError('toBotId is required');
    }

    // Verify target bot exists
    const toBot = await this.registry.getBot(toBotId);
    if (!toBot) {
      throw new TaskNotFoundError(toBotId);
    }

    if (toBot.status === 'offline') {
      this.logger.warn('Target bot is offline, task will be queued', { toBotId });
    }

    // Load task from DB
    const result = await this.db.query<TaskRow>(
      'SELECT * FROM tasks WHERE id = $1',
      [taskId]
    );
    if (result.rows.length === 0) {
      throw new TaskNotFoundError(taskId);
    }

    const task = taskRowToTask(result.rows[0]);
    if (task.status !== 'pending') {
      throw new InvalidTaskStateError(taskId, task.status, ['pending']);
    }

    // Check queue capacity
    const queueSize = await this.getQueueSize(toBotId);
    if (queueSize >= MAX_QUEUE_SIZE) {
      throw new QueueFullError(toBotId, queueSize, MAX_QUEUE_SIZE);
    }

    // Update to_bot_id in DB
    await this.db.query(
      'UPDATE tasks SET to_bot_id = $1, updated_at = NOW() WHERE id = $2',
      [toBotId, taskId]
    );

    task.toBotId = toBotId;

    // Keep participant graph in sync for collaboration/permissions.
    await this.upsertTaskParticipant(task.id, task.fromBotId, 'delegator', task.fromBotId);
    await this.upsertTaskParticipant(task.id, toBotId, 'executor', task.fromBotId);

    // Enqueue to Redis
    await this.enqueue(task);

    // Write task_notification to inbox
    try {
      await this.writeTaskNotificationToInbox(task);
    } catch (err) {
      this.logger.error('Failed to write task_notification to inbox', { err, taskId });
    }

    this.logger.info('Task delegated successfully', {
      taskId,
      toBotId,
      capability: task.capability,
      priority: task.priority,
    });
  }

  /**
   * Re-enqueue a task for retry
   */
  async enqueueForRetry(taskId: string): Promise<void> {
    const result = await this.db.query<TaskRow>(
      'SELECT * FROM tasks WHERE id = $1',
      [taskId]
    );
    if (result.rows.length === 0) {
      throw new TaskNotFoundError(taskId);
    }

    const task = taskRowToTask(result.rows[0]);
    await this.enqueue(task);

    // Also write task_notification to inbox so Router picks it up
    try {
      await this.writeTaskNotificationToInbox(task);
    } catch (err) {
      this.logger.error('Failed to write task_notification to inbox on retry', {
        err,
        taskId,
      });
    }

    this.logger.info('Task re-enqueued for retry', {
      taskId,
      retryCount: task.retryCount,
    });
  }

  /**
   * Register a delegate intent for a pre-created task.
   * Writes a delegate_intent message to fromBotId's own inbox so the
   * Gateway can poll it and trigger the spawn-based delegation flow.
   */
  async registerDelegateIntent(taskId: string, fromBotId: string): Promise<void> {
    // 1. Load task from DB and verify ownership
    const result = await this.db.query<TaskRow>(
      'SELECT * FROM tasks WHERE id = $1',
      [taskId]
    );
    if (result.rows.length === 0) {
      throw new TaskNotFoundError(taskId);
    }

    const task = taskRowToTask(result.rows[0]);
    if (task.fromBotId !== fromBotId) {
      throw new ValidationError(`Task ${taskId} does not belong to bot ${fromBotId}`);
    }

    // 2. Build inbox message
    const messageId = randomUUID();
    const traceId = randomUUID();
    const now = new Date();

    const inboxMessage = JSON.stringify({
      messageId,
      fromBotId,
      toBotId: fromBotId,        // write to own inbox
      type: 'delegate_intent',
      contentType: 'json',
      content: {
        taskId: task.id,
        prompt: task.prompt,
        capability: task.capability,
        parameters: task.parameters,
        priority: task.priority,
      },
      priority: 'high',
      taskId: task.id,
      traceId,
      timestamp: now.toISOString(),
    });

    // 3. LPUSH to high-priority inbox
    await this.redis.lpush(`clawteam:inbox:${fromBotId}:high`, inboxMessage);

    // 4. Persist to messages table (non-critical)
    try {
      await this.db.query(
        `INSERT INTO messages (id, from_bot_id, to_bot_id, type, content_type, content, priority, status, task_id, trace_id, created_at)
         VALUES ($1, $2, $3, 'delegate_intent', 'json', $4, 'high', 'delivered', $5, $6, $7)`,
        [
          messageId,
          fromBotId,
          fromBotId,
          JSON.stringify({
            taskId: task.id,
            prompt: task.prompt,
            capability: task.capability,
            parameters: task.parameters,
            priority: task.priority,
          }),
          task.id,
          traceId,
          now,
        ],
      );
    } catch (err) {
      this.logger.warn('Failed to persist delegate_intent to messages DB', {
        err,
        taskId: task.id,
      });
    }

    this.logger.info('Delegate intent registered', {
      taskId,
      fromBotId,
      messageId,
    });
  }

  async enqueue(task: Task): Promise<void> {
    const queueKey = `${REDIS_KEYS.TASK_QUEUE}:${task.toBotId}:${task.priority}`;
    const cacheKey = `${REDIS_KEYS.TASK_CACHE}:${task.id}`;

    try {
      await this.redis.rpush(queueKey, task.id);
      await this.redis.hset(cacheKey, 'data', JSON.stringify(task));
      await this.redis.hset(cacheKey, 'status', task.status);
      await this.redis.hset(cacheKey, 'toBotId', task.toBotId);

      const ttl = task.timeoutSeconds + CACHE_TTL_BUFFER_SECONDS;
      await this.redis.expire(cacheKey, ttl);
    } catch (err) {
      // Record Redis fallback metric
      redisFallbackTotal.inc({ operation: 'enqueue' });

      this.logger.warn(
        'Redis unavailable during enqueue, task will be polled from database',
        { err, taskId: task.id, component: 'TaskDispatcher' }
      );

      // Degraded mode: Task is already in database (from createTask)
      // Bot will retrieve it via pollFromDatabase fallback
      // Don't throw — allow task creation to succeed
    }
  }

  /**
   * Write a task_notification message to the unified inbox (Redis priority LIST + messages DB).
   * This is the mechanism by which the Router discovers new/retried tasks.
   */
  private async writeTaskNotificationToInbox(task: Task): Promise<void> {
    const messageId = randomUUID();
    const traceId = randomUUID();
    const now = new Date();

    const inboxMessage = JSON.stringify({
      messageId,
      fromBotId: task.fromBotId,
      toBotId: task.toBotId,
      type: 'task_notification',
      contentType: 'json',
      content: {
        taskId: task.id,
        prompt: task.prompt,
        capability: task.capability,
        parameters: task.parameters,
        taskType: task.type || 'new',
        parentTaskId: task.parentTaskId,
        senderSessionKey: task.senderSessionKey,
        humanContext: task.humanContext,
      },
      priority: task.priority,
      taskId: task.id,
      traceId,
      timestamp: now.toISOString(),
    });

    // Write to Redis priority inbox
    await this.redis.lpush(`clawteam:inbox:${task.toBotId}:${task.priority}`, inboxMessage);

    // Persist to messages DB for history
    try {
      await this.db.query(
        `INSERT INTO messages (id, from_bot_id, to_bot_id, type, content_type, content, priority, status, task_id, trace_id, created_at)
         VALUES ($1, $2, $3, 'task_notification', 'json', $4, $5, 'delivered', $6, $7, $8)`,
        [
          messageId,
          task.fromBotId,
          task.toBotId,
          JSON.stringify({
            taskId: task.id,
            prompt: task.prompt,
            capability: task.capability,
            parameters: task.parameters,
            taskType: task.type || 'new',
            parentTaskId: task.parentTaskId,
          }),
          task.priority,
          task.id,
          traceId,
          now,
        ],
      );
    } catch (err) {
      // Non-critical: inbox Redis write already succeeded, DB is for history only
      this.logger.warn('Failed to persist task_notification to messages DB', {
        err,
        taskId: task.id,
      });
    }
  }

  async getQueueSize(botId: string): Promise<number> {
    let total = 0;
    for (const priority of PRIORITY_ORDER) {
      const queueKey = `${REDIS_KEYS.TASK_QUEUE}:${botId}:${priority}`;
      const length = await this.redis.llen(queueKey);
      total += length;
    }
    return total;
  }

  /**
   * Create a task record in the database without enqueuing or notifying.
   * Used by /api/v1/tasks/create — pure DB INSERT, no bot validation, no queue, no inbox.
   * The task has to_bot_id = NULL; it can be assigned later via delegate or activate.
   */
  async createTaskRecord(req: TaskCreateRequest, fromBotId: string): Promise<Task> {
    const id = randomUUID();
    const now = new Date();
    const priority = req.priority || 'normal';
    const timeoutSeconds = req.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS;
    const maxRetries = DEFAULT_MAX_RETRIES;
    const taskType = req.type || 'new';

    await this.db.query(
      `INSERT INTO tasks (
        id, from_bot_id, to_bot_id, prompt, capability, parameters,
        status, priority, type, title, parent_task_id,
        timeout_seconds, max_retries,
        human_context, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        id, fromBotId, fromBotId, req.prompt || null,
        req.capability || 'general',
        JSON.stringify(req.parameters || {}),
        'pending', priority, taskType, req.title || null,
        req.parentTaskId || null,
        timeoutSeconds, maxRetries,
        req.humanContext || null,
        JSON.stringify({}),
        now,
      ]
    );

    // Seed participant graph: delegator + optional collaboration roster.
    await this.upsertTaskParticipant(id, fromBotId, 'delegator', fromBotId);
    const participantBotIds = extractParticipantBotIds(req.parameters).filter((botId) => botId !== fromBotId);
    for (const participantBotId of participantBotIds) {
      await this.upsertTaskParticipant(id, participantBotId, 'participant', fromBotId);
    }

    return {
      id,
      fromBotId,
      toBotId: '',
      prompt: req.prompt,
      capability: req.capability || 'general',
      parameters: req.parameters || {},
      status: 'pending',
      priority,
      type: taskType,
      title: req.title,
      parentTaskId: req.parentTaskId,
      timeoutSeconds,
      retryCount: 0,
      maxRetries,
      createdAt: now.toISOString(),
      humanContext: req.humanContext,
    };
  }
}
