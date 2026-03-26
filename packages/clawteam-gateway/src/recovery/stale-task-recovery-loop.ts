/**
 * Stale Task Recovery Loop
 *
 * Independent timer that periodically checks tracked tasks for stale sessions
 * and attempts recovery actions (nudge / restore+nudge / fallback to main).
 *
 * Design follows HeartbeatLoop pattern:
 * - Runs on its own setInterval, independent of polling and heartbeat
 * - Has overlap protection (isRunning flag)
 * - Individual recovery failures are logged, never interrupt the loop
 */

import type { Task } from '@clawteam/shared/types';
import type { Logger } from 'pino';
import type { IClawTeamApiClient } from '../clients/clawteam-api.js';
import type { ISessionClient, IMessageBuilder } from '../providers/types.js';
import type { SessionStatusResolver } from '../monitoring/session-status-resolver.js';
import type { SessionTracker } from '../routing/session-tracker.js';
import type { RoutedTasksTracker } from '../routing/routed-tasks.js';
import type { TaskSessionStatus } from '../monitoring/types.js';
import { STALE_SESSION_STATES } from './types.js';
import type { RecoveryResult } from './types.js';
import { RecoveryAttemptTracker } from './recovery-tracker.js';
import {
  c,
  colorizeState,
  printRecoveryBlock,
  printCleanupLine,
  printRecoveryTickSummary,
} from '../utils/visual-log.js';
import type { RecoveryStep } from '../utils/visual-log.js';

export interface StaleTaskRecoveryLoopOptions {
  resolver: SessionStatusResolver;
  clawteamApi: IClawTeamApiClient;
  sessionClient: ISessionClient;
  sessionTracker: SessionTracker;
  messageBuilder: IMessageBuilder;
  /** Shared routed-tasks tracker (also used by TaskPollingLoop) — cleared on reset so poller re-routes */
  routedTasks?: RoutedTasksTracker;
  intervalMs: number;
  stalenessThresholdMs: number;  /** How long a tool_calling session can be stuck before treated as dead (default: 10 min) */
  toolCallingTimeoutMs?: number;
  maxRecoveryAttempts: number;
  /** Main session key (e.g. "agent:main:main"), used to track routed pending tasks */
  mainSessionKey: string;
  gatewayUrl: string;
  /** This gateway's bot ID — used to identify delegator monitoring sessions */
  botId?: string;
  logger: Logger;
}

export class StaleTaskRecoveryLoop {
  private readonly resolver: SessionStatusResolver;
  private readonly clawteamApi: IClawTeamApiClient;
  private readonly sessionClient: ISessionClient;
  private readonly sessionTracker: SessionTracker;
  private readonly messageBuilder: IMessageBuilder;
  private readonly routedTasks: RoutedTasksTracker | null;
  private readonly intervalMs: number;
  private readonly stalenessThresholdMs: number;
  private readonly toolCallingTimeoutMs: number;
  private readonly mainSessionKey: string;
  private readonly gatewayUrl: string;
  private botId: string | null;
  private readonly logger: Logger;
  private readonly attemptTracker: RecoveryAttemptTracker;
  /** Tasks that exhausted all recovery attempts — skip in syncUntrackedTasks */
  private readonly exhaustedTaskIds = new Set<string>();
  /** First time the gateway saw each untracked task (used for staleness instead of createdAt) */
  private readonly firstSeenAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(options: StaleTaskRecoveryLoopOptions) {
    this.resolver = options.resolver;
    this.clawteamApi = options.clawteamApi;
    this.sessionClient = options.sessionClient;
    this.sessionTracker = options.sessionTracker;
    this.messageBuilder = options.messageBuilder;
    this.routedTasks = options.routedTasks ?? null;
    this.intervalMs = options.intervalMs;
    this.stalenessThresholdMs = options.stalenessThresholdMs;
    this.toolCallingTimeoutMs = options.toolCallingTimeoutMs ?? 600_000; // default 10 min
    this.mainSessionKey = options.mainSessionKey;
    this.gatewayUrl = options.gatewayUrl;
    this.botId = options.botId ?? null;
    this.logger = options.logger.child({ component: 'stale-task-recovery' });
    this.attemptTracker = new RecoveryAttemptTracker(options.maxRecoveryAttempts);
  }

  setBotId(newBotId: string): void {
    this.botId = newBotId;
    this.logger.info({ botId: newBotId }, 'StaleTaskRecoveryLoop botId updated');
  }

  /** Start the recovery loop. Runs first tick immediately, then on interval. */
  start(): void {
    if (this.timer) {
      this.logger.warn('Recovery loop already started');
      return;
    }

    this.logger.info(
      { intervalMs: this.intervalMs, stalenessThresholdMs: this.stalenessThresholdMs },
      'Stale task recovery loop started',
    );

    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  /** Stop the recovery loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('Stale task recovery loop stopped');
    }
  }

  /** Single tick: check all tracked tasks and recover stale ones. */
  async tick(): Promise<void> {
    if (this.isRunning) {
      this.logger.debug('Recovery tick skipped — previous tick still running');
      return;
    }

    this.isRunning = true;

    try {
      // Bootstrap: restore all session mappings from task_sessions table.
      // This is independent of task status — we sync ALL mappings for this bot,
      // and let the staleness/cleanup logic decide what to do with each.
      await this.bootstrapSessionMappings();

      // Sync untracked active tasks from API before staleness check.
      // This covers tasks (e.g. new→processing) that were routed to main
      // and spawned sub-sessions without going through sessionTracker.track().
      await this.syncUntrackedTasks();

      // Detect externally cancelled/completed tasks (e.g. cancelled from dashboard via API server)
      // and notify the session to stop work.
      await this.sweepCancelledTasks();

      const pairs = this.sessionTracker.getAllTracked();

      if (pairs.length === 0) {
        this.logger.debug('No tracked tasks, skipping recovery check');
        return;
      }

      this.logger.debug({ taskCount: pairs.length }, 'Checking tracked tasks for staleness');

      const statuses = await this.resolver.resolveForTasks(pairs);

      let recovered = 0;
      let skipped = 0;
      let cleaned = 0;

      for (const status of statuses) {
        try {
          const result = await this.processTaskStatus(status);
          if (!result) {
            skipped++;
          } else if (result.action === 'skip') {
            skipped++;
          } else if (result.success) {
            recovered++;
          }
          // Check if we cleaned up (task in terminal state)
          if (result && result.reason.includes('terminal state')) {
            cleaned++;
          }
        } catch (error) {
          this.logger.warn(
            { taskId: status.taskId, error: (error as Error).message },
            'Failed to process task status for recovery',
          );
        }
      }

      const summary = recovered > 0
        ? c.green(`recovered=${recovered}`)
        : `recovered=${recovered}`;
      this.logger.info(
        { recovered, skipped, cleaned, total: statuses.length },
        `Recovery tick complete: ${summary} skipped=${skipped} cleaned=${cleaned} total=${statuses.length}`,
      );

      // Visual terminal output
      printRecoveryTickSummary({ total: statuses.length, recovered, skipped, cleaned });

      // Clean up expired retired session mappings
      this.sessionTracker.cleanupRetired();
    } catch (error) {
      this.logger.error(
        { error: (error as Error).message },
        'Recovery tick failed',
      );
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Bootstrap session mappings from the API's task_sessions table.
   *
   * Queries ALL session mappings for this gateway's botId and loads them
   * into the in-memory SessionTracker. This is independent of task status —
   * we sync every mapping and let the staleness/cleanup logic decide what
   * to do with each tracked session.
   *
   * Runs on every tick (idempotent — already-tracked sessions are skipped).
   * Catches errors so a failing bootstrap never blocks the rest of the tick.
   */
  private async bootstrapSessionMappings(): Promise<void> {
    if (!this.botId) {
      this.logger.warn('bootstrapSessionMappings skipped — botId not set');
      return;
    }

    try {
      this.logger.info({ botId: this.botId }, 'bootstrapSessionMappings: querying task_sessions for bot');
      const sessions = await this.clawteamApi.getSessionsForBot(this.botId);
      this.logger.info(
        { botId: this.botId, returned: sessions.length },
        'bootstrapSessionMappings: API returned sessions',
      );

      let restored = 0;
      let skippedTracked = 0;
      let skippedExhausted = 0;

      for (const s of sessions) {
        if (this.sessionTracker.isTracked(s.taskId)) { skippedTracked++; continue; }
        if (this.exhaustedTaskIds.has(s.taskId)) { skippedExhausted++; continue; }

        this.sessionTracker.track(s.taskId, s.sessionKey);
        restored++;
        this.logger.info(
          { taskId: s.taskId, sessionKey: s.sessionKey, role: s.role },
          'bootstrapSessionMappings: restored mapping',
        );
      }

      this.logger.info(
        { restored, skippedTracked, skippedExhausted, total: sessions.length, botId: this.botId },
        'bootstrapSessionMappings: complete',
      );
    } catch (error) {
      this.logger.warn(
        { error: (error as Error).message, botId: this.botId },
        'bootstrapSessionMappings: FAILED — continuing with existing tracked sessions',
      );
    }
  }

  /**
   * Sync untracked active tasks from the API into SessionTracker.
   *
   * Three cases:
   * 1. Task has executorSessionKey (accepted/processing by sub-session)
   *    → track against that session key
   * 2. Pending task with parameters.targetSessionKey (sub-task routed
   *    to a sub-session, but sub-session hasn't accepted yet)
   *    → track against targetSessionKey so recovery can nudge that sub-session
   * 3. Pending task without executorSessionKey or targetSessionKey (new task
   *    routed to main, but main hasn't spawned a sub-session yet)
   *    → track against mainSessionKey so recovery can nudge main
   *
   * Cases 2 & 3 require the task to have been pending longer than
   * stalenessThresholdMs to avoid tracking tasks that just appeared.
   *
   * Catches errors so a failing sync never blocks the rest of the tick.
   */
  private async syncUntrackedTasks(): Promise<void> {
    try {
      const activeTasks = await this.clawteamApi.pollActiveTasks();
      let synced = 0;
      const now = Date.now();

      for (const task of activeTasks) {
        if (this.sessionTracker.isTracked(task.id)) {
          continue;
        }
        if (this.exhaustedTaskIds.has(task.id)) {
          continue;
        }

        // Pending tasks without a tracked session — determine target:
        // - sub-task with targetSessionKey → that sub-session
        // - otherwise (new task or no targetSessionKey) → main session
        // Only sync if pending long enough to avoid tracking freshly-created tasks.
        // Use gateway first-seen time (not task.createdAt) to avoid false staleness
        // when there's delay between task creation and gateway polling.
        if (task.status === 'pending') {
          if (!this.firstSeenAt.has(task.id)) {
            this.firstSeenAt.set(task.id, now);
          }
          const seenDuration = now - this.firstSeenAt.get(task.id)!;
          if (seenDuration < this.stalenessThresholdMs) {
            continue;
          }

          // Verify we can actually access this task via getTask() before syncing.
          // pollActiveTasks() returns ALL tasks when botId is empty (API list endpoint
          // bypasses permission), but getTask() enforces botId permission. Without this
          // check we'd sync a task, then processStaleSession() would call getTask() →
          // null → clean up a task that doesn't belong to this gateway.
          const taskDetail = await this.clawteamApi.getTask(task.id);
          if (!taskDetail) {
            this.logger.debug(
              { taskId: task.id },
              'Skipping untracked task — not accessible via getTask (botId mismatch?)',
            );
            this.exhaustedTaskIds.add(task.id);
            this.firstSeenAt.delete(task.id);
            continue;
          }

          const targetSessionKey =
            (task.parameters?.targetSessionKey as string) || this.mainSessionKey;

          this.sessionTracker.track(task.id, targetSessionKey);
          this.firstSeenAt.delete(task.id);
          synced++;
          this.logger.info(
            { taskId: task.id, sessionKey: targetSessionKey, seenMs: seenDuration, taskType: task.type },
            'Synced stale pending task (no executor yet)',
          );
        }
        // accepted/processing tasks without tracker entry: these should have been
        // tracked via the auto-tracker plugin. If not, they'll be picked up once
        // they go stale and the session tracker gets populated on next spawn.
      }

      if (synced > 0) {
        this.logger.info({ synced }, 'Finished syncing untracked tasks');
      }
    } catch (error) {
      this.logger.warn(
        { error: (error as Error).message },
        'Failed to sync active tasks from API, continuing with existing tracked tasks',
      );
    }
  }

  /**
   * Sweep all tracked tasks and detect externally cancelled/completed ones.
   *
   * When a task is cancelled from the dashboard (via API server), the gateway
   * doesn't get notified directly. This method polls the API for each tracked
   * task and, if it finds a terminal state, notifies the session to stop and
   * cleans up local tracking.
   */
  private async sweepCancelledTasks(): Promise<void> {
    const TERMINAL = new Set(['completed', 'failed', 'timeout', 'cancelled']);
    const pairs = this.sessionTracker.getAllTracked();
    if (pairs.length === 0) return;

    let cleaned = 0;
    for (const { taskId, sessionKey } of pairs) {
      try {
        const task = await this.clawteamApi.getTask(taskId);
        if (!task || !TERMINAL.has(task.status)) continue;

        const status = task.status;
        this.logger.info(
          { taskId, sessionKey, taskStatus: status },
          `External ${status} detected, notifying session and cleaning up`,
        );

        // Best-effort: tell the session to stop
        if (status === 'cancelled') {
          const message = [
            '[ClawTeam Task -- CANCELLED]',
            `Task ID: ${taskId}`,
            `Capability: ${task.capability}`,
            `Reason: Cancelled from dashboard`,
            '',
            'This task has been cancelled by the dashboard operator.',
            'Please STOP all work on this task immediately.',
            'Do NOT call the complete endpoint. The task is already cancelled.',
          ].join('\n');
          await this.sessionClient.sendToSession(sessionKey, message).catch(() => {});
        }

        this.sessionTracker.untrack(taskId);
        this.attemptTracker.remove(taskId);
        this.firstSeenAt.delete(taskId);
        this.exhaustedTaskIds.add(taskId);
        cleaned++;
        printCleanupLine(taskId, `${status} (external) — notified session & removed tracking`);
      } catch (error) {
        this.logger.debug(
          { taskId, error: (error as Error).message },
          'Failed to check task status during cancel sweep',
        );
      }
    }

    if (cleaned > 0) {
      this.logger.info({ cleaned }, 'Swept externally cancelled/completed tasks');
    }
  }

  /**
   * Process a single task's session status and decide on recovery action.
   * Returns null if the task is not stale (active/tool_calling/waiting/unknown).
   */
  async processTaskStatus(status: TaskSessionStatus): Promise<RecoveryResult | null> {
    const { taskId, sessionKey, sessionState } = status;

    // tool_calling sessions: normally considered active, but if stuck beyond
    // toolCallingTimeoutMs they are treated as dead (tool hung / never returned).
    if (sessionState === 'tool_calling') {
      const stuckMs = status.lastActivityAt
        ? Date.now() - status.lastActivityAt.getTime()
        : null;

      if (stuckMs !== null && stuckMs >= this.toolCallingTimeoutMs) {
        this.logger.warn(
          { taskId, sessionKey, stuckMs, threshold: this.toolCallingTimeoutMs },
          `${c.bgYellow(' TOOL_CALLING TIMEOUT ')} session stuck ${Math.round(stuckMs / 1000)}s > ${Math.round(this.toolCallingTimeoutMs / 1000)}s threshold, treating as dead`,
        );
        // Fall through to recovery as if session were dead
        return this.processStaleSession(taskId, sessionKey, 'dead', status);
      }

      // Under timeout — still considered active
      this.logger.debug(
        { taskId, sessionKey, sessionState, stuckMs },
        'tool_calling session under timeout, skipping',
      );
      this.attemptTracker.remove(taskId);
      return null;
    }

    // Not stale — skip
    if (!STALE_SESSION_STATES.has(sessionState)) {
      this.logger.debug(
        { taskId, sessionKey, sessionState },
        'Session not stale, skipping',
      );
      this.attemptTracker.remove(taskId);
      return null;
    }

    // For idle sessions, check if they've been idle long enough
    if (sessionState === 'idle' && status.lastActivityAt) {
      const idleDuration = Date.now() - status.lastActivityAt.getTime();
      if (idleDuration < this.stalenessThresholdMs) {
        this.logger.debug(
          { taskId, sessionKey, idleDuration, threshold: this.stalenessThresholdMs },
          'Session idle but under staleness threshold, skipping',
        );
        this.attemptTracker.remove(taskId);
        return null;
      }
    }

    // Session IS stale — proceed to recovery
    return this.processStaleSession(taskId, sessionKey, sessionState, status);
  }

  /**
   * Common recovery path for stale sessions (including tool_calling timeout).
   * Verifies task is still active, checks attempt limits, then executes recovery.
   */
  private async processStaleSession(
    taskId: string,
    sessionKey: string,
    effectiveState: string,
    status: TaskSessionStatus,
  ): Promise<RecoveryResult> {
    const idleMs = status.lastActivityAt
      ? Date.now() - status.lastActivityAt.getTime()
      : null;

    // Colored reason tag based on effective state
    const reasonTag = colorizeState(effectiveState, idleMs);
    this.logger.info(
      { taskId, sessionKey, sessionState: effectiveState, idleMs },
      `${reasonTag} Stale session detected, checking task status`,
    );

    // Verify task is still active via API
    const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'timeout', 'cancelled']);

    let task;
    try {
      task = await this.clawteamApi.getTask(taskId);
    } catch (error) {
      this.logger.warn(
        { taskId, error: (error as Error).message },
        'Failed to fetch task from API',
      );
      return { taskId, sessionKey, action: 'skip', success: false, reason: 'API fetch failed' };
    }

    // Tasks waiting for human input are legitimately paused — skip recovery
    if (task && task.status === 'waiting_for_input') {
      this.logger.debug({ taskId, sessionKey }, 'Task is waiting_for_input, skipping recovery');
      this.attemptTracker.remove(taskId);
      return { taskId, sessionKey, action: 'skip', success: true, reason: 'Task waiting for human input' };
    }

    // pending_review is also a legitimate wait state (waiting for delegator review).
    if (task && task.status === 'pending_review') {
      this.logger.debug({ taskId, sessionKey }, 'Task is pending_review, skipping recovery');
      this.attemptTracker.remove(taskId);
      return { taskId, sessionKey, action: 'skip', success: true, reason: 'Task pending review' };
    }

    // Delegator monitoring sessions are legitimately idle — skip recovery.
    // When this gateway delegated a task to another bot, the sub-session just
    // monitors progress. It's expected to be idle while the executor works.
    const ACTIVE_TASK_STATUSES = new Set(['pending', 'accepted', 'processing', 'waiting_for_input']);
    if (this.botId && task && task.fromBotId === this.botId && ACTIVE_TASK_STATUSES.has(task.status)) {
      this.logger.debug(
        { taskId, sessionKey, taskStatus: task.status, fromBotId: task.fromBotId },
        'Delegator monitoring session — task still active, skipping recovery',
      );
      this.attemptTracker.remove(taskId);
      return { taskId, sessionKey, action: 'skip', success: true, reason: 'Delegator monitoring session — task still active' };
    }

    // Task not found or in a terminal state — clean up
    if (!task || TERMINAL_TASK_STATUSES.has(task.status)) {
      this.logger.info(
        { taskId, sessionKey, taskStatus: task?.status ?? 'not_found' },
        `${c.gray('CLEANUP')} Task reached terminal state (${task?.status ?? 'not_found'}), removing tracking`,
      );
      this.sessionTracker.untrack(taskId);
      this.attemptTracker.remove(taskId);
      this.firstSeenAt.delete(taskId);
      printCleanupLine(taskId, `${task?.status ?? 'not_found'} — removed tracking`);
      return {
        taskId,
        sessionKey,
        action: 'skip',
        success: true,
        reason: `Task in terminal state (status: ${task?.status ?? 'not_found'})`,
      };
    }

    // Check if recovery attempts exhausted
    if (this.attemptTracker.isExhausted(taskId)) {
      const attempts = this.attemptTracker.getRecord(taskId)?.attempts ?? '?';
      const reason = `Recovery exhausted after ${attempts} attempts (session: ${effectiveState})`;

      // For non-dead sessions (idle/completed/errored), don't terminalize task.
      // Just stop nudging until a meaningful state change resets the counter.
      if (effectiveState !== 'dead') {
        this.logger.info(
          { taskId, sessionKey, sessionState: effectiveState, attempts },
          `${c.gray('EXHAUSTED')} Nudge attempts exhausted for non-dead session, skipping terminalization`,
        );
        return {
          taskId,
          sessionKey,
          action: 'skip',
          success: true,
          reason: `${reason} — non-dead session, keep task active`,
        };
      }

      // Pending tasks can't be "completed" → use cancel; accepted/processing → use fail
      let apiOk: boolean;
      let apiAction: string;
      if (task.status === 'pending') {
        this.logger.info(
          { taskId, sessionKey, sessionState: effectiveState },
          `${c.gray('EXHAUSTED')} Recovery attempts exhausted, cancelling pending task`,
        );
        apiOk = await this.clawteamApi.cancelTask(taskId, reason);
        apiAction = 'cancelled';
      } else {
        this.logger.info(
          { taskId, sessionKey, sessionState: effectiveState },
          `${c.gray('EXHAUSTED')} Recovery attempts exhausted, marking task as failed`,
        );
        apiOk = await this.clawteamApi.failTask(taskId, reason);
        apiAction = 'failed';
      }

      // Clean up local tracking + blacklist so syncUntrackedTasks won't re-sync
      this.sessionTracker.untrack(taskId);
      this.routedTasks?.remove(taskId);
      this.attemptTracker.remove(taskId);
      this.firstSeenAt.delete(taskId);
      this.exhaustedTaskIds.add(taskId);

      return {
        taskId, sessionKey,
        action: 'fail',
        success: apiOk,
        reason: apiOk
          ? `Task ${apiAction} (recovery exhausted)`
          : `Failed to ${apiAction} task on API (recovery exhausted)`,
      };
    }

    // Decide and execute recovery action
    return this.executeRecovery(taskId, sessionKey, effectiveState, task, idleMs);
  }

  /**
   * Execute the appropriate recovery action based on session state.
   */
  private async executeRecovery(
    taskId: string,
    sessionKey: string,
    sessionState: string,
    task: Task,
    idleMs: number | null,
  ): Promise<RecoveryResult> {
    const record = this.attemptTracker.getRecord(taskId);
    const attemptNum = (record?.attempts ?? 0) + 1;

    if (sessionState === 'dead') {
      return this.handleDeadSession(taskId, sessionKey, task, attemptNum);
    }

    // idle / completed / errored → nudge
    return this.handleNudge(taskId, sessionKey, sessionState, task, attemptNum, idleMs);
  }

  /**
   * Handle dead session: try restore first, then nudge.
   * If restore fails, reset task via API so polling loop re-routes it normally.
   * If API reset also fails, send a fallback message using normal task format.
   */
  private async handleDeadSession(
    taskId: string,
    sessionKey: string,
    task: Task,
    attemptNum: number,
  ): Promise<RecoveryResult> {
    this.attemptTracker.recordAttempt(taskId, 'dead');
    const steps: RecoveryStep[] = [];

    const maxAttempts = this.attemptTracker['maxAttempts'];
    const emitBlock = (outcome: { success: boolean; summary: string }): void => {
      printRecoveryBlock({
        taskId, capability: task.capability || 'general', sessionKey,
        sessionState: 'dead', idleMs: null, taskStatus: task.status,
        steps, outcome,
        thresholdMs: this.toolCallingTimeoutMs,
        attemptNum, maxAttempts,
      });
    };

    // Try to restore the session
    const canRestore = typeof this.sessionClient.restoreSession === 'function';
    if (canRestore) {
      try {
        const restored = await this.sessionClient.restoreSession!(sessionKey);
        if (restored) {
          this.logger.info({ taskId, sessionKey }, `${c.bgGreen(' RESTORE OK ')} Session restored, sending nudge`);
          steps.push({ label: 'Restore session', ok: true, detail: 'restored' });
          const nudgeMsg = this.messageBuilder.buildNudgeMessage(taskId, task, 'dead', attemptNum, this.attemptTracker['maxAttempts']);
          const sent = await this.sessionClient.sendToSession(sessionKey, nudgeMsg);
          steps.push({ label: 'Nudge', ok: sent, detail: sent ? 'sent' : 'send failed' });
          const result: RecoveryResult = {
            taskId, sessionKey,
            action: 'restore_and_nudge', success: sent,
            reason: sent ? 'Restored and nudged' : 'Restored but nudge send failed',
          };
          emitBlock({ success: sent, summary: result.reason });
          return result;
        }
        steps.push({ label: 'Restore session', ok: false, detail: 'not restored' });
      } catch (error) {
        this.logger.warn(
          { taskId, sessionKey, error: (error as Error).message },
          `${c.red('RESTORE FAILED')} Session restore failed`,
        );
        steps.push({ label: 'Restore session', ok: false, detail: 'failed' });
      }
    }

    // Restore failed — pending tasks don't need resetTask (already pending, would 409)
    if (task.status === 'pending') {
      this.logger.info({ taskId, sessionKey }, `${c.yellow('PENDING SKIP RESET')} Task is pending, untracking for re-route by poller`);
      this.routedTasks?.remove(taskId);
      this.sessionTracker.untrack(taskId);
      this.attemptTracker.remove(taskId);
      this.firstSeenAt.delete(taskId);
      steps.push({ label: 'Untrack pending', ok: true, detail: 'poller will re-route' });
      emitBlock({ success: true, summary: 'Untracked — poller will re-route' });
      return {
        taskId,
        sessionKey,
        action: 'fallback_to_main',
        success: true,
        reason: 'Pending task untracked for re-route (skip resetTask)',
      };
    }

    // Restore failed — try to reset the task via API so polling loop re-routes it
    this.logger.info({ taskId, sessionKey }, `${c.yellow('API RESET')} Attempting task reset via API`);
    const resetOk = await this.clawteamApi.resetTask(taskId);

    if (resetOk) {
      this.logger.info({ taskId, sessionKey }, `${c.bgGreen(' RESET OK ')} Task reset to pending, will be re-routed by poller`);
      this.routedTasks?.remove(taskId);
      this.sessionTracker.untrack(taskId);
      this.attemptTracker.remove(taskId);
      this.firstSeenAt.delete(taskId);
      steps.push({ label: 'API reset task', ok: true, detail: 'reset to pending' });
      emitBlock({ success: true, summary: 'Untracked — poller will re-route' });
      return {
        taskId,
        sessionKey,
        action: 'fallback_to_main',
        success: true,
        reason: 'Task reset to pending via API',
      };
    }

    // API reset failed — last resort: send message to main using normal task format
    this.logger.warn({ taskId, sessionKey }, `${c.bgRed(' API RESET FAILED ')} Sending fallback message to main`);
    steps.push({ label: 'API reset task', ok: false, detail: 'reset failed' });
    const fallbackMsg = this.messageBuilder.buildRecoveryFallbackMessage(task);
    const sent = await this.sessionClient.sendToMainSession(fallbackMsg);
    steps.push({ label: 'Fallback to main', ok: sent, detail: sent ? 'sent' : 'send failed' });
    this.sessionTracker.untrack(taskId);
    this.firstSeenAt.delete(taskId);
    const deadResult: RecoveryResult = {
      taskId, sessionKey,
      action: 'fallback_to_main', success: sent,
      reason: sent ? 'Fallback to main session (API reset failed)' : 'Fallback send failed',
    };
    emitBlock({ success: sent, summary: deadResult.reason });
    return deadResult;
  }

  /**
   * Handle nudge for idle/completed/errored sessions.
   */
  private async handleNudge(
    taskId: string,
    sessionKey: string,
    sessionState: string,
    task: Task,
    attemptNum: number,
    idleMs: number | null,
  ): Promise<RecoveryResult> {
    this.attemptTracker.recordAttempt(taskId, sessionState as any);

    const nudgeMsg = this.messageBuilder.buildNudgeMessage(taskId, task, sessionState, attemptNum, this.attemptTracker['maxAttempts']);
    const sent = await this.sessionClient.sendToSession(sessionKey, nudgeMsg);

    this.logger.info(
      { taskId, sessionKey, sessionState, attemptNum, sent },
      sent
        ? `${c.blue('NUDGE')} Nudge sent (attempt ${attemptNum})`
        : `${c.red('NUDGE FAILED')} Nudge send failed (attempt ${attemptNum})`,
    );

    const maxAttempts = this.attemptTracker['maxAttempts'];
    const nudgeResult: RecoveryResult = {
      taskId, sessionKey,
      action: 'nudge', success: sent,
      reason: sent ? `Nudge sent (attempt ${attemptNum})` : 'Nudge send failed',
    };

    printRecoveryBlock({
      taskId, capability: task.capability || 'general', sessionKey,
      sessionState, idleMs, taskStatus: task.status,
      steps: [{ label: `Nudge (${attemptNum}/${maxAttempts})`, ok: sent, detail: sent ? 'sent' : 'send failed' }],
      outcome: { success: sent, summary: sent ? 'Nudge delivered' : 'Nudge send failed' },
      thresholdMs: sessionState === 'idle' ? this.stalenessThresholdMs : undefined,
      attemptNum, maxAttempts,
    });

    return nudgeResult;
  }

}
