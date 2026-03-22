/**
 * Mock Task Coordinator Implementation
 * Used for testing and development when database/Redis are not available.
 */

import type { Task, TaskStatus, TaskCreateRequest, TaskCompleteRequest, PaginatedResponse } from '@clawteam/shared/types';
import type { ITaskCoordinator, TaskQueryOptions } from './interface';
import { ValidationError } from '@clawteam/api/common';
import {
  CoordinatorError,
  TaskNotFoundError,
  TaskAlreadyAcceptedError,
  UnauthorizedTaskError,
  InvalidTaskStateError,
  QueueFullError,
} from './errors';
import {
  MAX_QUEUE_SIZE,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_MAX_RETRIES,
  PRIORITY_ORDER,
} from './constants';

/**
 * In-memory mock implementation of ITaskCoordinator.
 * Useful for unit testing and parallel development.
 */
export class MockTaskCoordinator implements ITaskCoordinator {
  private tasks = new Map<string, Task>();
  private queues = new Map<string, string[]>(); // botId:priority -> taskId[]
  private taskCounter = 0;

  async createTask(req: TaskCreateRequest, fromBotId: string): Promise<Task> {
    const task: Task = {
      id: `mock-task-${++this.taskCounter}`,
      fromBotId,
      toBotId: '',
      prompt: req.prompt,
      capability: req.capability || 'general',
      parameters: req.parameters || {},
      status: 'pending',
      priority: req.priority || 'normal',
      type: req.type || 'new',
      title: req.title,
      parentTaskId: req.parentTaskId,
      timeoutSeconds: req.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS,
      retryCount: 0,
      maxRetries: DEFAULT_MAX_RETRIES,
      createdAt: new Date().toISOString(),
      humanContext: req.humanContext,
    };

    this.tasks.set(task.id, task);
    return task;
  }

  async registerDelegateIntent(taskId: string, fromBotId: string): Promise<void> {
    const task = this.getTaskOrThrow(taskId);
    if (task.fromBotId !== fromBotId) {
      throw new ValidationError(`Task ${taskId} does not belong to bot ${fromBotId}`);
    }
    // In mock, just record the intent (no actual inbox)
  }

  async delegate(taskId: string, toBotId: string): Promise<void> {
    const task = this.getTaskOrThrow(taskId);
    if (!toBotId) {
      throw new ValidationError('toBotId is required');
    }

    const queueSize = this.getQueueSizeForBot(toBotId);
    if (queueSize >= MAX_QUEUE_SIZE) {
      throw new QueueFullError(toBotId, queueSize, MAX_QUEUE_SIZE);
    }

    task.toBotId = toBotId;
    this.addToQueue(toBotId, task.priority, task.id);
  }

  async poll(botId: string, limit: number = 10): Promise<Task[]> {
    const tasks: Task[] = [];

    for (const priority of PRIORITY_ORDER) {
      if (tasks.length >= limit) break;

      const queueKey = `${botId}:${priority}`;
      const queue = this.queues.get(queueKey) || [];

      for (const taskId of queue) {
        if (tasks.length >= limit) break;
        const task = this.tasks.get(taskId);
        if (task && task.status === 'pending') {
          tasks.push(task);
        }
      }
    }

    return tasks;
  }

  async accept(taskId: string, botId: string, executorSessionKey?: string): Promise<void> {
    const task = this.getTaskOrThrow(taskId);

    if (task.toBotId !== botId) {
      throw new UnauthorizedTaskError(taskId, botId);
    }
    if (task.status !== 'pending') {
      throw new TaskAlreadyAcceptedError(taskId);
    }

    // Merged accept + start: pending → processing directly
    const now = new Date().toISOString();
    task.status = 'processing';
    task.acceptedAt = now;
    task.startedAt = now;
    if (executorSessionKey) task.executorSessionKey = executorSessionKey;

    this.removeFromQueue(task.toBotId, task.id);
  }

  async complete(taskId: string, req: TaskCompleteRequest, botId: string): Promise<void> {
    const task = this.getTaskOrThrow(taskId);

    if (task.fromBotId !== botId) {
      throw new UnauthorizedTaskError(taskId, botId);
    }
    const validStates: TaskStatus[] = ['accepted', 'processing', 'waiting_for_input', 'pending_review'];
    if (!validStates.includes(task.status)) {
      throw new InvalidTaskStateError(taskId, task.status, validStates);
    }

    task.status = req.status === 'completed' ? 'completed' : 'failed';
    task.result = req.result;
    task.error = req.error;
    task.completedAt = new Date().toISOString();
  }

  async submitResult(taskId: string, result: any, botId: string): Promise<void> {
    const task = this.getTaskOrThrow(taskId);
    if (task.toBotId !== botId) throw new UnauthorizedTaskError(taskId, botId);
    const validStates: TaskStatus[] = ['accepted', 'processing', 'waiting_for_input'];
    if (!validStates.includes(task.status)) {
      throw new InvalidTaskStateError(taskId, task.status, validStates);
    }
    task.status = 'pending_review' as TaskStatus;
    task.submittedResult = result;
    task.submittedAt = new Date().toISOString();
  }

  async approve(taskId: string, botId: string, resultOverride?: any): Promise<void> {
    const task = this.getTaskOrThrow(taskId);
    if (task.fromBotId !== botId) throw new UnauthorizedTaskError(taskId, botId);
    if (task.status !== ('pending_review' as TaskStatus)) {
      throw new InvalidTaskStateError(taskId, task.status, ['pending_review']);
    }
    task.status = 'completed';
    task.result = resultOverride ?? task.submittedResult;
    task.completedAt = new Date().toISOString();
  }

  async reject(taskId: string, botId: string, reason: string): Promise<void> {
    const task = this.getTaskOrThrow(taskId);
    if (task.fromBotId !== botId) throw new UnauthorizedTaskError(taskId, botId);
    if (task.status !== ('pending_review' as TaskStatus)) {
      throw new InvalidTaskStateError(taskId, task.status, ['pending_review']);
    }
    task.status = 'processing';
    task.rejectionReason = reason;
  }

  async cancel(taskId: string, reason: string, botId: string): Promise<void> {
    const task = this.getTaskOrThrow(taskId);

    if (task.fromBotId !== botId) {
      throw new UnauthorizedTaskError(taskId, botId);
    }
    if (task.status !== 'pending' && task.status !== 'accepted') {
      throw new InvalidTaskStateError(taskId, task.status, ['pending', 'accepted']);
    }

    task.status = 'cancelled' as TaskStatus;
    task.error = { code: 'CANCELLED', message: reason };
    task.completedAt = new Date().toISOString();

    this.removeFromQueue(task.toBotId, taskId);
  }

  async waitForInput(taskId: string, botId: string, reason: string, _targetBotId?: string): Promise<void> {
    const task = this.getTaskOrThrow(taskId);
    if (task.toBotId !== botId) throw new UnauthorizedTaskError(taskId, botId);
    if (task.status !== 'accepted' && task.status !== 'processing') {
      throw new InvalidTaskStateError(taskId, task.status, ['accepted', 'processing']);
    }
    task.status = 'waiting_for_input' as TaskStatus;
    task.result = { ...(task.result || {}), waitingReason: reason };
  }

  async resume(taskId: string, botId: string, input?: string, _targetBotId?: string): Promise<void> {
    const task = this.getTaskOrThrow(taskId);
    if (task.toBotId !== botId && task.fromBotId !== botId) {
      throw new UnauthorizedTaskError(taskId, botId);
    }

    if (task.status === ('waiting_for_input' as TaskStatus)) {
      task.status = 'processing';
      if (input) {
        task.result = { ...(task.result || {}), humanInput: input };
      }
    } else if (['completed', 'failed', 'timeout'].includes(task.status)) {
      const existingResult = (task.result || {}) as any;
      const previousResults = existingResult.previousResults || [];
      previousResults.push({ status: task.status, result: existingResult, completedAt: task.completedAt, prompt: task.prompt });

      task.status = 'processing';
      if (input) task.prompt = input;
      task.result = { previousResults, continuationCount: previousResults.length };
      task.error = undefined;
      task.completedAt = undefined;
    } else {
      throw new InvalidTaskStateError(taskId, task.status, ['waiting_for_input', 'completed', 'failed', 'timeout']);
    }
  }

  async reset(taskId: string, botId: string): Promise<void> {
    const task = this.getTaskOrThrow(taskId);

    if (task.toBotId !== botId) {
      throw new UnauthorizedTaskError(taskId, botId);
    }
    if (task.status !== 'accepted' && task.status !== 'processing') {
      throw new InvalidTaskStateError(taskId, task.status, ['accepted', 'processing']);
    }
    if (task.retryCount >= task.maxRetries) {
      throw new CoordinatorError(
        `Task ${taskId} has exhausted retries (${task.retryCount}/${task.maxRetries})`,
        'RETRY_EXHAUSTED',
        400,
        { taskId, retryCount: task.retryCount, maxRetries: task.maxRetries },
      );
    }

    task.status = 'pending';
    task.executorSessionKey = undefined;
    task.retryCount += 1;
    task.acceptedAt = undefined;
    task.startedAt = undefined;

    this.addToQueue(task.toBotId, task.priority, task.id);
  }

  async getTask(taskId: string, botId: string): Promise<Task | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    if (task.fromBotId !== botId && task.toBotId !== botId) {
      return null;
    }

    return task;
  }

  async getTasksByBot(
    botId: string,
    options?: TaskQueryOptions
  ): Promise<PaginatedResponse<Task>> {
    const role = options?.role || 'all';
    const statusFilter = options?.status || [];
    const page = options?.page || 1;
    const limit = options?.limit || 20;

    const filtered = Array.from(this.tasks.values()).filter((t) => {
      if (role === 'from' && t.fromBotId !== botId) return false;
      if (role === 'to' && t.toBotId !== botId) return false;
      if (role === 'all' && t.fromBotId !== botId && t.toBotId !== botId) return false;

      if (statusFilter.length > 0 && !statusFilter.includes(t.status)) return false;

      return true;
    });

    const total = filtered.length;
    const offset = (page - 1) * limit;
    const items = filtered.slice(offset, offset + limit);

    return {
      items,
      total,
      page,
      pageSize: limit,
      hasMore: offset + limit < total,
    };
  }

  async retry(taskId: string): Promise<void> {
    const task = this.getTaskOrThrow(taskId);
    task.status = 'pending';
    task.retryCount += 1;
    task.createdAt = new Date().toISOString();

    this.addToQueue(task.toBotId, task.priority, task.id);
  }

  async cleanupExpiredTasks(): Promise<number> {
    const now = Date.now();
    let count = 0;

    for (const [taskId, task] of this.tasks.entries()) {
      const createdAt = new Date(task.createdAt).getTime();
      const expiredAt = createdAt + (task.timeoutSeconds + 3600) * 1000;

      if (now > expiredAt && task.status !== 'completed' && task.status !== 'failed') {
        this.tasks.delete(taskId);
        count++;
      }
    }

    return count;
  }

  // ===== Test helper methods =====

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getTaskById(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  resetAll(): void {
    this.tasks.clear();
    this.queues.clear();
    this.taskCounter = 0;
  }

  // ===== Private helpers =====

  private getTaskOrThrow(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }
    return task;
  }

  private addToQueue(botId: string, priority: string, taskId: string): void {
    const key = `${botId}:${priority}`;
    const queue = this.queues.get(key) || [];
    queue.push(taskId);
    this.queues.set(key, queue);
  }

  private removeFromQueue(botId: string, taskId: string): void {
    for (const priority of PRIORITY_ORDER) {
      const key = `${botId}:${priority}`;
      const queue = this.queues.get(key);
      if (queue) {
        const idx = queue.indexOf(taskId);
        if (idx !== -1) {
          queue.splice(idx, 1);
        }
      }
    }
  }

  private getQueueSizeForBot(botId: string): number {
    let total = 0;
    for (const priority of PRIORITY_ORDER) {
      const key = `${botId}:${priority}`;
      const queue = this.queues.get(key) || [];
      total += queue.length;
    }
    return total;
  }
}
