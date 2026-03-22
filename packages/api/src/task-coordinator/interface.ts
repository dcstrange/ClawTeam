/**
 * Task Coordinator Interface Definitions
 */

import type { Task, TaskStatus, TaskCreateRequest, TaskCompleteRequest, PaginatedResponse } from '@clawteam/shared/types';

/**
 * Options for querying a bot's tasks
 */
export interface TaskQueryOptions {
  /** Filter by bot role: sender, receiver, or both */
  role?: 'from' | 'to' | 'all';
  /** Filter by task statuses */
  status?: TaskStatus[];
  /** Page number (1-based) */
  page?: number;
  /** Items per page */
  limit?: number;
}

/**
 * Response returned after delegating a task
 */
export interface TaskDelegateResponse {
  taskId: string;
  status: TaskStatus;
  estimatedCompletion: string;
  trackingUrl: string;
}

/**
 * Core Task Coordinator interface.
 * Both real and mock implementations satisfy this contract.
 */
export interface ITaskCoordinator {
  /**
   * Create a task record without enqueuing or notifying.
   * Pure DB INSERT — no bot validation, no queue, no inbox.
   * Used for pre-creating tasks before delegation or plugin auto-tracking.
   */
  createTask(req: TaskCreateRequest, fromBotId: string): Promise<Task>;

  /**
   * Delegate a pre-created task to a target bot.
   * Sets to_bot_id, enqueues to Redis, and writes task_notification to inbox.
   * The task must already exist in DB (created via createTask).
   */
  delegate(taskId: string, toBotId: string): Promise<void>;

  /**
   * Poll pending tasks for a bot, ordered by priority (urgent > high > normal > low).
   * This is a non-destructive read — tasks remain in the queue until accepted.
   */
  poll(botId: string, limit?: number): Promise<Task[]>;

  /**
   * Accept a pending task and start processing immediately (pending → processing).
   * Removes from queue, adds to processing ZSET, notifies originator.
   * Only the target bot (toBotId) can accept.
   * @throws TaskNotFoundError if task doesn't exist
   * @throws UnauthorizedTaskError if bot is not the target
   * @throws TaskAlreadyAcceptedError if task is not pending
   */
  accept(taskId: string, botId: string, executorSessionKey?: string): Promise<void>;

  /**
   * Complete a task with a result or error.
   * Only the delegator (fromBotId) can call this directly (skip review).
   */
  complete(taskId: string, req: TaskCompleteRequest, botId: string): Promise<void>;

  /**
   * Submit task result for review (executor → pending_review).
   * Only the executor (toBotId) can call this.
   */
  submitResult(taskId: string, result: any, botId: string): Promise<void>;

  /**
   * Approve a pending_review task (delegator → completed).
   * Only the delegator (fromBotId) can call this.
   */
  approve(taskId: string, botId: string, resultOverride?: any): Promise<void>;

  /**
   * Reject a pending_review task (delegator → processing).
   * Only the delegator (fromBotId) can call this.
   */
  reject(taskId: string, botId: string, reason: string): Promise<void>;

  /**
   * Cancel a pending or accepted task.
   * Only the originating bot (fromBotId) can cancel.
   */
  cancel(taskId: string, reason: string, botId: string): Promise<void>;

  /**
   * Get task details. Only the sender or receiver bot can view.
   * Returns null if not found or unauthorized.
   */
  getTask(taskId: string, botId: string): Promise<Task | null>;

  /**
   * Get paginated task list for a bot.
   */
  getTasksByBot(botId: string, options?: TaskQueryOptions): Promise<PaginatedResponse<Task>>;

  /**
   * Mark a task as waiting for human input.
   */
  waitForInput(taskId: string, botId: string, reason: string, targetBotId?: string): Promise<void>;

  /**
   * Unified resume: handles both waiting_for_input and completed/failed/timeout states.
   * - waiting_for_input: resumes with optional input (human reply)
   * - completed/failed/timeout: continues with new instructions, preserving history
   */
  resume(taskId: string, botId: string, input?: string, targetBotId?: string): Promise<void>;

  /**
   * Reset an accepted/processing task back to pending for re-routing.
   * Increments retryCount. Used by recovery when a sub-session dies.
   * @throws InvalidTaskStateError if task is not in accepted/processing state
   * @throws CoordinatorError if retries exhausted
   */
  reset(taskId: string, botId: string): Promise<void>;

  /**
   * Register a delegate intent for a pre-created task.
   * Writes a delegate_intent message to fromBotId's inbox so the
   * Gateway can poll it and trigger the spawn-based delegation flow.
   */
  registerDelegateIntent(taskId: string, fromBotId: string): Promise<void>;

  /**
   * Retry a failed or timed-out task by re-enqueuing it.
   */
  retry(taskId: string): Promise<void>;

  /**
   * Clean up expired tasks. Returns the number of tasks cleaned.
   */
  cleanupExpiredTasks(): Promise<number>;
}
