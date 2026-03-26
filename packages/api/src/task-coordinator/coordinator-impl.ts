/**
 * TaskCoordinatorImpl - Aggregates all core components into a single ITaskCoordinator.
 */

import type { Task, TaskCreateRequest, TaskCompleteRequest, PaginatedResponse } from '@clawteam/shared/types';
import type { DatabasePool, RedisClient, Logger } from '@clawteam/api/common';
import type { ITaskCoordinator, TaskQueryOptions } from './interface';
import type { TaskRow } from './types';
import { taskRowToTask } from './types';
import { TaskDispatcher } from './dispatcher';
import { TaskPoller } from './poller';
import { TaskCompleter } from './completer';
import { TimeoutDetector } from './timeout-detector';
import { REDIS_KEYS, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './constants';

export interface TaskCoordinatorImplDeps {
  db: DatabasePool;
  redis: RedisClient;
  logger: Logger;
  dispatcher: TaskDispatcher;
  poller: TaskPoller;
  completer: TaskCompleter;
  timeoutDetector: TimeoutDetector;
}

/**
 * Concrete implementation of ITaskCoordinator that delegates to
 * dispatcher, poller, completer, and timeout-detector components.
 */
export class TaskCoordinatorImpl implements ITaskCoordinator {
  private readonly db: DatabasePool;
  private readonly redis: RedisClient;
  private readonly logger: Logger;
  private readonly dispatcher: TaskDispatcher;
  private readonly poller: TaskPoller;
  private readonly completer: TaskCompleter;
  readonly timeoutDetector: TimeoutDetector;

  constructor(deps: TaskCoordinatorImplDeps) {
    this.db = deps.db;
    this.redis = deps.redis;
    this.logger = deps.logger;
    this.dispatcher = deps.dispatcher;
    this.poller = deps.poller;
    this.completer = deps.completer;
    this.timeoutDetector = deps.timeoutDetector;
  }

  async createTask(req: TaskCreateRequest, fromBotId: string): Promise<Task> {
    return this.dispatcher.createTaskRecord(req, fromBotId);
  }

  async delegate(taskId: string, toBotId: string): Promise<void> {
    return this.dispatcher.delegate(taskId, toBotId);
  }

  async registerDelegateIntent(taskId: string, fromBotId: string): Promise<void> {
    return this.dispatcher.registerDelegateIntent(taskId, fromBotId);
  }

  async poll(botId: string, limit?: number): Promise<Task[]> {
    return this.poller.poll(botId, limit);
  }

  async accept(taskId: string, botId: string, executorSessionKey?: string): Promise<void> {
    return this.completer.accept(taskId, botId, executorSessionKey);
  }

  async complete(taskId: string, req: TaskCompleteRequest, botId: string): Promise<void> {
    return this.completer.complete(taskId, req, botId);
  }

  async submitResult(taskId: string, result: any, botId: string): Promise<void> {
    return this.completer.submitResult(taskId, result, botId);
  }

  async approve(taskId: string, botId: string, resultOverride?: any): Promise<void> {
    return this.completer.approve(taskId, botId, resultOverride);
  }

  async reject(taskId: string, botId: string, reason: string): Promise<void> {
    return this.completer.reject(taskId, botId, reason);
  }

  async requestChanges(taskId: string, botId: string, feedback: string): Promise<void> {
    return this.completer.requestChanges(taskId, botId, feedback);
  }

  async cancel(taskId: string, reason: string, botId: string): Promise<void> {
    return this.completer.cancel(taskId, reason, botId);
  }

  async waitForInput(taskId: string, botId: string, reason: string, targetBotId?: string): Promise<void> {
    return this.completer.waitForInput(taskId, botId, reason, targetBotId);
  }

  async resume(taskId: string, botId: string, input?: string, targetBotId?: string): Promise<void> {
    return this.completer.resume(taskId, botId, input, targetBotId);
  }

  async reset(taskId: string, botId: string): Promise<void> {
    return this.completer.reset(taskId, botId);
  }

  async getTask(taskId: string, botId: string): Promise<Task | null> {
    const result = await this.db.query<TaskRow>(
      'SELECT * FROM tasks WHERE id = $1',
      [taskId]
    );
    if (result.rows.length === 0) return null;

    const task = taskRowToTask(result.rows[0]);
    if (task.fromBotId === botId || task.toBotId === botId) return task;

    try {
      const participant = await this.db.query<{ task_id: string }>(
        `SELECT task_id
           FROM task_participants
          WHERE task_id = $1
            AND bot_id = $2
          LIMIT 1`,
        [taskId, botId],
      );
      if ((participant.rowCount ?? 0) > 0) return task;
    } catch {
      // Backward-compatible fallback before migration; ignore and continue.
    }
    return null;
  }

  async getTasksByBot(
    botId: string,
    opts?: TaskQueryOptions
  ): Promise<PaginatedResponse<Task>> {
    const role = opts?.role || 'all';
    const statusFilter = opts?.status || [];
    const page = opts?.page || 1;
    const limit = Math.min(opts?.limit || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = (page - 1) * limit;

    let whereClause: string;
    const params: unknown[] = [botId];

    if (role === 'from') {
      whereClause = 'from_bot_id = $1';
    } else if (role === 'to') {
      whereClause = 'to_bot_id = $1';
    } else {
      whereClause = `(from_bot_id = $1 OR to_bot_id = $1 OR EXISTS (
        SELECT 1
          FROM task_participants tp
         WHERE tp.task_id = tasks.id
           AND tp.bot_id = $1
      ))`;
    }

    if (statusFilter.length > 0) {
      const placeholders = statusFilter.map((_, i) => `$${params.length + i + 1}`).join(', ');
      whereClause += ` AND status IN (${placeholders})`;
      params.push(...statusFilter);
    }

    const countResult = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tasks WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const dataResult = await this.db.query<TaskRow>(
      `SELECT * FROM tasks WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    const items = dataResult.rows.map(taskRowToTask);

    return {
      items,
      total,
      page,
      pageSize: limit,
      hasMore: offset + limit < total,
    };
  }

  async retry(taskId: string): Promise<void> {
    await this.dispatcher.enqueueForRetry(taskId);
  }

  async cleanupExpiredTasks(): Promise<number> {
    const result = await this.db.query<TaskRow>(
      `SELECT * FROM tasks
       WHERE status IN ('pending', 'accepted', 'processing')
       AND created_at + ((timeout_seconds + 3600) || ' seconds')::INTERVAL < NOW()`
    );

    for (const row of result.rows) {
      await this.db.query(
        `UPDATE tasks SET status = 'timeout', completed_at = NOW() WHERE id = $1`,
        [row.id]
      );
      await this.redis.del(`${REDIS_KEYS.TASK_CACHE}:${row.id}`);
    }

    this.logger.info('Cleaned up expired tasks', { count: result.rows.length });
    return result.rows.length;
  }
}
