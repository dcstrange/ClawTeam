/**
 * Task Completer - Handles accept, start, complete, cancel operations
 */

import type { Task, TaskCompleteRequest } from '@clawteam/shared/types';
import { randomUUID } from 'node:crypto';
import type { IMessageBus } from '@clawteam/api/message-bus';
import type { DatabasePool, RedisClient, Logger } from '@clawteam/api/common';
import { taskRowToTask, type TaskRow } from './types';
import {
  CoordinatorError,
  TaskNotFoundError,
  TaskAlreadyAcceptedError,
  UnauthorizedTaskError,
  InvalidTaskStateError,
} from './errors';
import { PRIORITY_ORDER, REDIS_KEYS } from './constants';
import { tasksCompletedTotal, tasksCancelledTotal, taskDuration } from './metrics';

export interface TaskCompleterDeps {
  db: DatabasePool;
  redis: RedisClient;
  messageBus: IMessageBus;
  logger: Logger;
}

export class TaskCompleter {
  private readonly db: DatabasePool;
  private readonly redis: RedisClient;
  private readonly messageBus: IMessageBus;
  private readonly logger: Logger;

  constructor(deps: TaskCompleterDeps) {
    this.db = deps.db;
    this.redis = deps.redis;
    this.messageBus = deps.messageBus;
    this.logger = deps.logger;
  }

  async accept(taskId: string, botId: string, executorSessionKey?: string): Promise<void> {
    const task = await this.loadTask(taskId);

    if (task.toBotId !== botId) {
      throw new UnauthorizedTaskError(taskId, botId);
    }
    if (task.status !== 'pending') {
      throw new TaskAlreadyAcceptedError(taskId);
    }

    const now = new Date();

    // Merge accept + start: go directly from pending → processing
    const updateResult = executorSessionKey
      ? await this.db.query(
          `UPDATE tasks SET status = 'processing', accepted_at = $1, started_at = $1, executor_session_key = $3
           WHERE id = $2 AND status = 'pending'`,
          [now, taskId, executorSessionKey]
        )
      : await this.db.query(
          `UPDATE tasks SET status = 'processing', accepted_at = $1, started_at = $1
           WHERE id = $2 AND status = 'pending'`,
          [now, taskId]
        );

    if (updateResult.rowCount === 0) {
      throw new InvalidTaskStateError(taskId, task.status, ['pending']);
    }

    // Remove from queue
    await this.removeFromQueue(taskId, task.toBotId);

    // Add to processing ZSET for timeout detection
    const timeoutAt = now.getTime() + task.timeoutSeconds * 1000;
    await this.redis.zadd(REDIS_KEYS.PROCESSING_SET, timeoutAt.toString(), taskId);

    // Update cache
    await this.updateCacheStatus(taskId, 'processing');

    // Notify originating bot
    await this.safePublish('task_assigned', {
      taskId,
      status: 'processing',
      acceptedAt: now.toISOString(),
    }, task.fromBotId);

    this.logger.info('Task accepted and started', { taskId, botId });
  }

  async complete(taskId: string, req: TaskCompleteRequest, botId: string): Promise<void> {
    const task = await this.loadTask(taskId);

    // Only fromBotId (delegator) can call complete directly (skip review).
    // Also allow fromBotId to fail tasks (e.g. recovery loop).
    const isFailing = req.status === 'failed' || (!req.status && req.error);
    if (task.fromBotId !== botId && !(isFailing && task.toBotId === botId)) {
      throw new UnauthorizedTaskError(taskId, botId);
    }
    const validStates = ['accepted', 'processing', 'waiting_for_input', 'pending_review'];
    if (!validStates.includes(task.status)) {
      throw new InvalidTaskStateError(taskId, task.status, validStates);
    }

    const now = new Date();
    // 智能推断最终状态：
    // 1. 如果明确指定了 status，使用指定的值
    // 2. 如果有 error 且没有指定 status，默认为 'failed'
    // 3. 如果有 result 且没有 error，默认为 'completed'
    const finalStatus = req.status
      ? req.status
      : req.error
        ? 'failed'
        : 'completed';

    const updateResult = await this.db.query(
      `UPDATE tasks
       SET status = $1, result = $2, error = $3, completed_at = $4
       WHERE id = $5 AND status IN ('accepted', 'processing', 'waiting_for_input', 'pending_review')`,
      [
        finalStatus,
        req.result ? JSON.stringify(req.result) : null,
        req.error ? JSON.stringify(req.error) : null,
        now,
        taskId,
      ]
    );

    if (updateResult.rowCount === 0) {
      // Task was cancelled or otherwise changed between loadTask and UPDATE
      this.logger.warn('Task complete rejected — status changed (likely cancelled)', { taskId, loadedStatus: task.status });
      throw new InvalidTaskStateError(taskId, task.status, validStates);
    }

    // Record task completion metrics
    tasksCompletedTotal.inc({
      status: finalStatus,
      capability: task.capability,
    });

    // Record task duration
    const durationSeconds = (now.getTime() - new Date(task.createdAt).getTime()) / 1000;
    taskDuration.observe(
      { capability: task.capability, status: finalStatus },
      durationSeconds
    );

    // Remove from processing ZSET
    await this.redis.zrem(REDIS_KEYS.PROCESSING_SET, taskId);

    // Clear cache
    await this.redis.del(`${REDIS_KEYS.TASK_CACHE}:${taskId}`);

    // Notify originating bot
    const event = finalStatus === 'completed' ? 'task_completed' : 'task_failed';
    await this.safePublish(event, {
      taskId,
      status: finalStatus,
      result: req.result,
      error: req.error,
    }, task.fromBotId);

    this.logger.info('Task completed', { taskId, botId, status: finalStatus });
  }

  async reset(taskId: string, botId: string): Promise<void> {
    const task = await this.loadTask(taskId);

    if (task.toBotId !== botId) {
      throw new UnauthorizedTaskError(taskId, botId);
    }
    const resetableStates = ['accepted', 'processing', 'waiting_for_input'];
    if (!resetableStates.includes(task.status)) {
      throw new InvalidTaskStateError(taskId, task.status, resetableStates);
    }
    if (task.retryCount >= task.maxRetries) {
      throw new CoordinatorError(
        `Task ${taskId} has exhausted retries (${task.retryCount}/${task.maxRetries})`,
        'RETRY_EXHAUSTED',
        400,
        { taskId, retryCount: task.retryCount, maxRetries: task.maxRetries },
      );
    }

    const updateResult = await this.db.query(
      `UPDATE tasks
       SET status = 'pending',
           executor_session_key = NULL,
           retry_count = retry_count + 1,
           accepted_at = NULL,
           started_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND status IN ('accepted', 'processing', 'waiting_for_input')`,
      [taskId],
    );

    if (updateResult.rowCount === 0) {
      throw new InvalidTaskStateError(taskId, task.status, resetableStates);
    }

    // Re-enqueue in priority queue so poll picks it up
    const queueKey = `${REDIS_KEYS.TASK_QUEUE}:${task.toBotId}:${task.priority}`;
    await this.redis.lpush(queueKey, taskId);

    // Remove from processing ZSET
    await this.redis.zrem(REDIS_KEYS.PROCESSING_SET, taskId);

    // Clear cache so fresh data is fetched
    await this.redis.del(`${REDIS_KEYS.TASK_CACHE}:${taskId}`);

    this.logger.info('Task reset to pending', { taskId, botId, retryCount: task.retryCount + 1 });
  }

  async waitForInput(taskId: string, botId: string, reason: string, targetBotId?: string): Promise<void> {
    const task = await this.loadTask(taskId);

    // Allow both executor (toBotId) and delegator (fromBotId) to mark as waiting
    if (task.toBotId !== botId && task.fromBotId !== botId) {
      throw new UnauthorizedTaskError(taskId, botId);
    }
    // Also allow pending:
    // - Delegator may need to request human input before executor explicitly accepts.
    // - Executor may call need-human-input immediately after receiving assignment.
    const validStates = ['pending', 'accepted', 'processing', 'waiting_for_input'];
    if (!validStates.includes(task.status)) {
      throw new InvalidTaskStateError(taskId, task.status, validStates);
    }

    // Determine who actually requested human input.
    let requestedBy = botId;
    if (targetBotId && (targetBotId === task.toBotId || targetBotId === task.fromBotId)) {
      requestedBy = targetBotId;
    }

    // Build waitingRequests array — supports concurrent requests from multiple bots.
    // Each bot can have at most one pending request; a new call from the same bot
    // replaces its previous reason.
    const existingResult = task.result || {};
    const existingRequests: Array<{ botId: string; reason: string }> =
      (existingResult as any).waitingRequests || [];
    const filtered = existingRequests.filter((r: any) => r.botId !== requestedBy);
    const waitingRequests = [...filtered, { botId: requestedBy, reason }];

    // Keep legacy single-value fields pointing to the latest request for backward compat
    const result = {
      ...existingResult,
      waitingRequests,
      waitingReason: reason,
      waitingRequestedBy: requestedBy,
    };
    const wasPending = task.status === 'pending';
    const updateResult = await this.db.query(
      `UPDATE tasks
       SET status = 'waiting_for_input',
           result = $1,
           accepted_at = CASE WHEN status = 'pending' THEN COALESCE(accepted_at, NOW()) ELSE accepted_at END,
           started_at = CASE WHEN status = 'pending' THEN COALESCE(started_at, NOW()) ELSE started_at END,
           updated_at = NOW()
       WHERE id = $2 AND status IN ('pending', 'accepted', 'processing', 'waiting_for_input')`,
      [JSON.stringify(result), taskId],
    );

    if (updateResult.rowCount === 0) {
      throw new InvalidTaskStateError(taskId, task.status, validStates);
    }

    // pending -> waiting_for_input is a task-start transition:
    // remove from pending queue and add to processing set for timeout tracking.
    if (wasPending) {
      await this.removeFromQueue(taskId, task.toBotId);
      const timeoutAt = Date.now() + task.timeoutSeconds * 1000;
      await this.redis.zadd(REDIS_KEYS.PROCESSING_SET, timeoutAt.toString(), taskId);
    }

    await this.updateCacheStatus(taskId, 'waiting_for_input');

    // Record human_input_request event as a message for Activity Tree
    try {
      const msgId = randomUUID();
      const traceId = randomUUID();
      const now = new Date();
      const content = JSON.stringify({ text: `[Need Human Input] ${reason}` });
      await this.db.query(
        `INSERT INTO messages (id, from_bot_id, to_bot_id, type, content_type, content, priority, status, task_id, trace_id, created_at)
         VALUES ($1, $2, $3, 'human_input_request', 'text', $4, 'normal', 'delivered', $5, $6, $7)`,
        [msgId, botId, botId, content, taskId, traceId, now],
      );
    } catch (err) {
      this.logger.error('Failed to write human_input_request message', { taskId, err });
    }

    this.logger.info('Task waiting for input', { taskId, botId, reason });
  }

  /**
   * Unified resume: handles both waiting_for_input and completed/failed/timeout states.
   * - waiting_for_input: resumes with optional humanInput (original resumeFromWaiting logic)
   * - completed/failed/timeout: continues with new instructions (original continueTask logic)
   */
  async resume(taskId: string, botId: string, input?: string, targetBotId?: string): Promise<void> {
    const task = await this.loadTask(taskId);

    // Allow both fromBotId and toBotId
    if (task.toBotId !== botId && task.fromBotId !== botId) {
      throw new UnauthorizedTaskError(taskId, botId);
    }

    if (task.status === 'waiting_for_input') {
      // --- Original resumeFromWaiting logic ---
      const existingResult = (task.result || {}) as any;
      const existingRequests: Array<{ botId: string; reason: string }> =
        existingResult.waitingRequests || [];
      const remainingRequests = existingRequests.filter((r: any) => r.botId !== botId);

      const nextStatus = remainingRequests.length > 0 ? 'waiting_for_input' : 'processing';

      const resultPatch: any = { waitingRequests: remainingRequests };
      if (input) {
        resultPatch.humanInput = input;
      }
      if (remainingRequests.length > 0) {
        resultPatch.waitingReason = remainingRequests[0].reason;
        resultPatch.waitingRequestedBy = remainingRequests[0].botId;
      }

      const updateResult = await this.db.query(
        `UPDATE tasks SET status = $1, updated_at = NOW(),
         result = COALESCE(result, '{}'::jsonb) || $2::jsonb
         WHERE id = $3 AND status = 'waiting_for_input'`,
        [nextStatus, JSON.stringify(resultPatch), taskId],
      );

      if (updateResult.rowCount === 0) {
        throw new InvalidTaskStateError(taskId, task.status, ['waiting_for_input']);
      }

      await this.updateCacheStatus(taskId, nextStatus);

      // Record human_input_response event as a message for Activity Tree
      try {
        const msgId = randomUUID();
        const traceId = randomUUID();
        const now = new Date();
        const content = JSON.stringify({ text: input ? `[Human Reply] ${input}` : '[Task Resumed]' });
        await this.db.query(
          `INSERT INTO messages (id, from_bot_id, to_bot_id, type, content_type, content, priority, status, task_id, trace_id, created_at)
           VALUES ($1, $2, $3, 'human_input_response', 'text', $4, 'normal', 'delivered', $5, $6, $7)`,
          [msgId, botId, botId, content, taskId, traceId, now],
        );
      } catch (err) {
        this.logger.error('Failed to write human_input_response message', { taskId, err });
      }

      this.logger.info('Task resumed from waiting', { taskId, botId });

      if (input) {
        try {
          await this.writeResumeInputToInbox(task, input, botId, botId);
          // If delegator provided human input, proactively forward the same input
          // to executor so execution can continue without manual relay.
          if (botId === task.fromBotId && task.toBotId && task.toBotId !== botId) {
            await this.writeResumeInputToInbox(task, input, task.toBotId, botId);
          }
        } catch (err) {
          this.logger.error('Failed to write humanInput to inbox', { taskId, err });
        }
      }
    } else if (['completed', 'failed', 'timeout'].includes(task.status)) {
      // --- Original continueTask logic ---
      const existingResult = (task.result || {}) as any;
      const previousResults = existingResult.previousResults || [];
      previousResults.push({
        status: task.status,
        result: existingResult,
        completedAt: task.completedAt,
        prompt: task.prompt,
      });
      const newResult = { previousResults, continuationCount: previousResults.length };

      const updateResult = await this.db.query(
        `UPDATE tasks SET
           status = 'processing',
           prompt = $1,
           result = $2,
           error = NULL,
           completed_at = NULL,
           updated_at = NOW()
         WHERE id = $3 AND status IN ('completed', 'failed', 'timeout')`,
        [input || task.prompt, JSON.stringify(newResult), taskId],
      );

      if (updateResult.rowCount === 0) {
        throw new InvalidTaskStateError(taskId, task.status, ['completed', 'failed', 'timeout']);
      }

      await this.redis.del(`${REDIS_KEYS.TASK_CACHE}:${taskId}`);

      const messageTarget = targetBotId || botId;
      try {
          await this.writeContinueToInbox(task, input || task.prompt || '', messageTarget, botId);
        } catch (err) {
          this.logger.error('Failed to write continue message to inbox', { taskId, messageTarget, err });
        }

      // Write task_continuation message for Activity Tree
      try {
        const msgId = randomUUID();
        const traceId = randomUUID();
        const now = new Date();
        const content = JSON.stringify({ text: `[Task Continued] ${input || ''}` });
        await this.db.query(
          `INSERT INTO messages (id, from_bot_id, to_bot_id, type, content_type, content, priority, status, task_id, trace_id, created_at)
           VALUES ($1, $2, $3, 'task_continuation', 'text', $4, 'normal', 'delivered', $5, $6, $7)`,
          [msgId, botId, task.toBotId, content, taskId, traceId, now],
        );
      } catch (err) {
        this.logger.error('Failed to write task_continuation message', { taskId, err });
      }

      await this.safePublish('task_continued', { taskId, prompt: input, continuedBy: botId }, task.toBotId);

      this.logger.info('Task continued (direct to processing)', { taskId, botId, messageTarget, continuationCount: previousResults.length });
    } else {
      throw new InvalidTaskStateError(taskId, task.status, ['waiting_for_input', 'completed', 'failed', 'timeout']);
    }
  }

  /**
   * Write a direct_message with humanInput to the requesting bot's inbox.
   */
  private async writeResumeInputToInbox(
    task: Task,
    humanInput: string,
    targetBotId: string,
    senderBotId: string,
  ): Promise<void> {
    const messageId = randomUUID();
    const traceId = randomUUID();
    const now = new Date();

    const fileHintSignal = `${task.prompt || ''}\n${humanInput || ''}`;
    const needsFileHint = /(file service|附件|文件|云空间|workspace|upload|上传|\.html|\.md|\.txt|artifact)/i.test(fileHintSignal);
    const fileHint = needsFileHint
      ? (
        `\n\n[Task File Service Quick Start]\n` +
        `Use your gateway URL from system prompt (for example: http://localhost:3100).\n` +
        `1) List task files:\n` +
        `curl -s $GATEWAY/gateway/tasks/${task.id}/files\n` +
        `2) Read doc artifact:\n` +
        `curl -s $GATEWAY/gateway/tasks/${task.id}/files/docs/<docId>/raw\n` +
        `3) Read file artifact (base64 json):\n` +
        `curl -s "$GATEWAY/gateway/tasks/${task.id}/files/download/<nodeId>?format=json"\n`
      )
      : '';

    const content = {
      text:
        `[Human Input for Task ${task.id}]\n\n` +
        `${humanInput}` +
        `${fileHint}\n` +
        `Please continue working on the task using this information.`,
    };

    const inboxMessage = JSON.stringify({
      messageId,
      fromBotId: senderBotId,
      toBotId: targetBotId,
      type: 'direct_message',
      contentType: 'text',
      content,
      priority: 'high',
      taskId: task.id,
      traceId,
      timestamp: now.toISOString(),
    });

    await this.redis.lpush(`clawteam:inbox:${targetBotId}:high`, inboxMessage);

    await this.db.query(
      `INSERT INTO messages (id, from_bot_id, to_bot_id, type, content_type, content, priority, status, task_id, trace_id, created_at)
       VALUES ($1, $2, $3, 'direct_message', 'text', $4, 'high', 'delivered', $5, $6, $7)`,
      [messageId, senderBotId, targetBotId, JSON.stringify(content), task.id, traceId, now],
    );

    this.logger.info('Wrote humanInput to requesting bot inbox', { taskId: task.id, senderBotId, targetBotId });
  }

  /**
   * Write a direct_message with continuation instructions to the target bot's inbox.
   */
  private async writeContinueToInbox(
    task: Task,
    prompt: string,
    targetBotId: string,
    senderBotId: string,
  ): Promise<void> {
    const messageId = randomUUID();
    const traceId = randomUUID();
    const now = new Date();

    const content = {
      text: `[Task Continuation for ${task.id}]\n\n${prompt}\n\nPlease continue working on the task with these updated instructions.`,
    };

    const inboxMessage = JSON.stringify({
      messageId,
      fromBotId: senderBotId,
      toBotId: targetBotId,
      type: 'direct_message',
      contentType: 'text',
      content,
      priority: 'high',
      taskId: task.id,
      traceId,
      timestamp: now.toISOString(),
    });

    await this.redis.lpush(`clawteam:inbox:${targetBotId}:high`, inboxMessage);

    await this.db.query(
      `INSERT INTO messages (id, from_bot_id, to_bot_id, type, content_type, content, priority, status, task_id, trace_id, created_at)
       VALUES ($1, $2, $3, 'direct_message', 'text', $4, 'high', 'delivered', $5, $6, $7)`,
      [messageId, senderBotId, targetBotId, JSON.stringify(content), task.id, traceId, now],
    );

    this.logger.info('Wrote continuation message to target bot inbox', { taskId: task.id, senderBotId, targetBotId });
  }

  /**
   * Write a direct_message to delegator inbox when executor submits final result.
   * This is consumed by gateway poller and routed to delegator session for review.
   */
  private async writePendingReviewToInbox(task: Task, submittedResult: any, submittedAt: Date): Promise<void> {
    const messageId = randomUUID();
    const traceId = randomUUID();

    const content = {
      text:
        `[Task Pending Review]\n\n` +
        `Task ${task.id} has entered pending_review.\n` +
        `The executor submitted a final result. Review must be done via your delegator bot session (approve/reject).`,
      submittedResult,
      submittedAt: submittedAt.toISOString(),
    };

    const inboxMessage = JSON.stringify({
      messageId,
      fromBotId: task.toBotId,
      toBotId: task.fromBotId,
      type: 'direct_message',
      contentType: 'text',
      content,
      priority: 'high',
      taskId: task.id,
      traceId,
      timestamp: submittedAt.toISOString(),
    });

    await this.redis.lpush(`clawteam:inbox:${task.fromBotId}:high`, inboxMessage);

    await this.db.query(
      `INSERT INTO messages (id, from_bot_id, to_bot_id, type, content_type, content, priority, status, task_id, trace_id, created_at)
       VALUES ($1, $2, $3, 'direct_message', 'text', $4, 'high', 'delivered', $5, $6, $7)`,
      [messageId, task.toBotId, task.fromBotId, JSON.stringify(content), task.id, traceId, submittedAt],
    );

    this.logger.info('Wrote pending_review notification to delegator inbox', {
      taskId: task.id,
      fromBotId: task.toBotId,
      toBotId: task.fromBotId,
    });
  }

  /**
   * Write review decision event to executor inbox for full activity history:
   * - approved: delegator accepted submitted result
   * - rejected: delegator requested rework with reason
   */
  private async writeReviewDecisionToInbox(
    task: Task,
    decision: { action: 'approved' | 'rejected'; reason?: string; result?: any },
    reviewedAt: Date,
  ): Promise<void> {
    const messageId = randomUUID();
    const traceId = randomUUID();

    const content =
      decision.action === 'approved'
        ? {
          text:
            `[Task Review Approved]\n\n` +
            `Task ${task.id} was approved by delegator ${task.fromBotId}.`,
          reviewAction: 'approved',
          approvedResult: decision.result ?? null,
          reviewedAt: reviewedAt.toISOString(),
        }
        : {
          text:
            `[Task Review Rejected]\n\n` +
            `Task ${task.id} was rejected by delegator ${task.fromBotId}.\n` +
            `Reason: ${decision.reason || 'Rejected'}`,
          reviewAction: 'rejected',
          rejectionReason: decision.reason || 'Rejected',
          reviewedAt: reviewedAt.toISOString(),
        };

    const inboxMessage = JSON.stringify({
      messageId,
      fromBotId: task.fromBotId,
      toBotId: task.toBotId,
      type: 'direct_message',
      contentType: 'text',
      content,
      priority: 'high',
      taskId: task.id,
      traceId,
      timestamp: reviewedAt.toISOString(),
    });

    await this.redis.lpush(`clawteam:inbox:${task.toBotId}:high`, inboxMessage);

    await this.db.query(
      `INSERT INTO messages (id, from_bot_id, to_bot_id, type, content_type, content, priority, status, task_id, trace_id, created_at)
       VALUES ($1, $2, $3, 'direct_message', 'text', $4, 'high', 'delivered', $5, $6, $7)`,
      [messageId, task.fromBotId, task.toBotId, JSON.stringify(content), task.id, traceId, reviewedAt],
    );

    this.logger.info('Wrote review decision notification to executor inbox', {
      taskId: task.id,
      action: decision.action,
      fromBotId: task.fromBotId,
      toBotId: task.toBotId,
    });
  }

  async submitResult(taskId: string, result: any, botId: string): Promise<void> {
    const task = await this.loadTask(taskId);

    // Only executor (toBotId) can submit result
    if (task.toBotId !== botId) {
      throw new UnauthorizedTaskError(taskId, botId);
    }
    const validStates = ['accepted', 'processing', 'waiting_for_input'];
    if (!validStates.includes(task.status)) {
      if (task.status === 'pending_review') {
        this.logger.info('Task already submitted for review, ignoring duplicate submit', { taskId });
        return; // Idempotent: already submitted
      }
      throw new InvalidTaskStateError(taskId, task.status, validStates);
    }

    const now = new Date();

    const updateResult = await this.db.query(
      `UPDATE tasks
       SET status = 'pending_review', submitted_result = $1, submitted_at = $2, updated_at = NOW()
       WHERE id = $3 AND status IN ('accepted', 'processing', 'waiting_for_input')`,
      [JSON.stringify(result), now, taskId],
    );

    if (updateResult.rowCount === 0) {
      throw new InvalidTaskStateError(taskId, task.status, validStates);
    }

    // Keep in processing ZSET (timeout still applies until approved)
    await this.updateCacheStatus(taskId, 'pending_review');

    // Ensure delegator receives this in inbox so gateway can route into delegator session.
    try {
      await this.writePendingReviewToInbox(task, result, now);
    } catch (err) {
      this.logger.error('Failed to write pending_review message to delegator inbox', { taskId, err });
    }

    // Notify delegator
    await this.safePublish('task_pending_review', {
      taskId,
      status: 'pending_review',
      submittedResult: result,
      submittedAt: now.toISOString(),
    }, task.fromBotId);

    this.logger.info('Task submitted for review', { taskId, botId });
  }

  async approve(taskId: string, botId: string, resultOverride?: any): Promise<void> {
    const task = await this.loadTask(taskId);

    // Only delegator (fromBotId) can approve
    if (task.fromBotId !== botId) {
      throw new UnauthorizedTaskError(taskId, botId);
    }
    if (task.status !== 'pending_review') {
      throw new InvalidTaskStateError(taskId, task.status, ['pending_review']);
    }

    const now = new Date();
    const finalResult = resultOverride ?? task.submittedResult;

    const updateResult = await this.db.query(
      `UPDATE tasks
       SET status = 'completed', result = $1, completed_at = $2, updated_at = NOW()
       WHERE id = $3 AND status = 'pending_review'`,
      [finalResult ? JSON.stringify(finalResult) : null, now, taskId],
    );

    if (updateResult.rowCount === 0) {
      throw new InvalidTaskStateError(taskId, task.status, ['pending_review']);
    }

    // Record metrics
    tasksCompletedTotal.inc({ status: 'completed', capability: task.capability });
    const durationSeconds = (now.getTime() - new Date(task.createdAt).getTime()) / 1000;
    taskDuration.observe({ capability: task.capability, status: 'completed' }, durationSeconds);

    // Clean up Redis
    await this.redis.zrem(REDIS_KEYS.PROCESSING_SET, taskId);
    await this.redis.del(`${REDIS_KEYS.TASK_CACHE}:${taskId}`);

    // Persist review decision event in message history for Activity Tree.
    try {
      await this.writeReviewDecisionToInbox(task, { action: 'approved', result: finalResult }, now);
    } catch (err) {
      this.logger.error('Failed to write approve decision message', { taskId, err });
    }

    // Notify executor
    await this.safePublish('task_completed', {
      taskId,
      status: 'completed',
      result: finalResult,
    }, task.toBotId);

    this.logger.info('Task approved', { taskId, botId });
  }

  async reject(taskId: string, botId: string, reason: string): Promise<void> {
    const task = await this.loadTask(taskId);

    // Only delegator (fromBotId) can reject
    if (task.fromBotId !== botId) {
      throw new UnauthorizedTaskError(taskId, botId);
    }
    if (task.status !== 'pending_review') {
      throw new InvalidTaskStateError(taskId, task.status, ['pending_review']);
    }

    const updateResult = await this.db.query(
      `UPDATE tasks
       SET status = 'processing', rejection_reason = $1, updated_at = NOW()
       WHERE id = $2 AND status = 'pending_review'`,
      [reason, taskId],
    );

    if (updateResult.rowCount === 0) {
      throw new InvalidTaskStateError(taskId, task.status, ['pending_review']);
    }

    await this.updateCacheStatus(taskId, 'processing');

    // Persist review decision event in message history for Activity Tree.
    try {
      await this.writeReviewDecisionToInbox(task, { action: 'rejected', reason }, new Date());
    } catch (err) {
      this.logger.error('Failed to write reject decision message', { taskId, err });
    }

    // Notify executor with rejection details
    await this.safePublish('task_rejected', {
      taskId,
      status: 'processing',
      rejectionReason: reason,
    }, task.toBotId);

    this.logger.info('Task rejected', { taskId, botId, reason });
  }

  async cancel(taskId: string, reason: string, botId: string): Promise<void> {
    const task = await this.loadTask(taskId);

    if (task.fromBotId !== botId) {
      throw new UnauthorizedTaskError(taskId, botId);
    }
    const cancellableStates = ['pending', 'accepted', 'processing', 'waiting_for_input', 'pending_review'];
    if (!cancellableStates.includes(task.status)) {
      throw new InvalidTaskStateError(taskId, task.status, cancellableStates);
    }

    const now = new Date();

    const updateResult = await this.db.query(
      `UPDATE tasks
       SET status = 'cancelled', error = $1, completed_at = $2
       WHERE id = $3 AND status IN ('pending', 'accepted', 'processing', 'waiting_for_input', 'pending_review')`,
      [
        JSON.stringify({ code: 'CANCELLED', message: reason }),
        now,
        taskId,
      ]
    );

    if (updateResult.rowCount === 0) {
      throw new InvalidTaskStateError(taskId, task.status, cancellableStates);
    }

    // Clean up Redis
    await this.removeFromQueue(taskId, task.toBotId);
    await this.redis.zrem(REDIS_KEYS.PROCESSING_SET, taskId);
    await this.redis.del(`${REDIS_KEYS.TASK_CACHE}:${taskId}`);

    // Record cancellation metric
    tasksCancelledTotal.inc({ capability: task.capability });

    // Notify target bot
    await this.safePublish('task_failed', {
      taskId,
      status: 'cancelled',
      reason,
    }, task.toBotId);

    this.logger.info('Task cancelled', { taskId, botId, reason });
  }

  private async loadTask(taskId: string): Promise<Task> {
    const result = await this.db.query<TaskRow>(
      'SELECT * FROM tasks WHERE id = $1',
      [taskId]
    );
    if (result.rows.length === 0) {
      throw new TaskNotFoundError(taskId);
    }
    return taskRowToTask(result.rows[0]);
  }

  private async removeFromQueue(taskId: string, botId: string): Promise<void> {
    for (const priority of PRIORITY_ORDER) {
      const queueKey = `${REDIS_KEYS.TASK_QUEUE}:${botId}:${priority}`;
      await this.redis.lrem(queueKey, 0, taskId);
    }
  }

  private async updateCacheStatus(taskId: string, status: string): Promise<void> {
    const cacheKey = `${REDIS_KEYS.TASK_CACHE}:${taskId}`;
    const exists = await this.redis.exists(cacheKey);
    if (exists) {
      await this.redis.hset(cacheKey, 'status', status);
    }
  }

  private async safePublish(
    event: 'task_assigned' | 'task_completed' | 'task_failed' | 'task_continued' | 'task_pending_review' | 'task_rejected',
    payload: unknown,
    targetBotId: string
  ): Promise<void> {
    try {
      await this.messageBus.publish(event, payload, targetBotId);
    } catch (err) {
      this.logger.error(`Failed to publish ${event} event`, {
        err,
        targetBotId,
      });
    }
  }
}
