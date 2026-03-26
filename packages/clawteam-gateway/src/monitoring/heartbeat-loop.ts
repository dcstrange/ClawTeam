/**
 * Heartbeat Loop
 *
 * Independent timer that periodically resolves session statuses for all
 * tracked tasks and reports heartbeats to the ClawTeam API server.
 *
 * Design:
 * - Runs on its own setInterval, independent of TaskPollingLoop
 * - Has overlap protection (isRunning flag) to prevent concurrent ticks
 * - Individual heartbeat failures are logged as warnings, never interrupt the loop
 * - Fire-and-forget POST to /api/v1/tasks/:taskId/heartbeat
 */

import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { IClawTeamApiClient } from '../clients/clawteam-api.js';
import type { ISessionResolver } from '../providers/types.js';
import type { SessionTracker } from '../routing/session-tracker.js';
import type { HeartbeatPayload, TaskSessionStatus } from './types.js';

export interface HeartbeatLoopOptions {
  resolver: ISessionResolver;
  clawteamApi: IClawTeamApiClient;
  sessionTracker: SessionTracker;
  intervalMs: number;
  logger: Logger;
}

export class HeartbeatLoop extends EventEmitter {
  private readonly resolver: ISessionResolver;
  private readonly clawteamApi: IClawTeamApiClient;
  private readonly sessionTracker: SessionTracker;
  private readonly intervalMs: number;
  private readonly logger: Logger;
  private timer: ReturnType<typeof setInterval> | null;
  private isRunning: boolean;

  constructor(options: HeartbeatLoopOptions) {
    super();
    this.timer = null;
    this.isRunning = false;
    this.resolver = options.resolver;
    this.clawteamApi = options.clawteamApi;
    this.sessionTracker = options.sessionTracker;
    this.intervalMs = options.intervalMs;
    this.logger = options.logger.child({ component: 'heartbeat-loop' });
  }

  /** Start the heartbeat loop. Runs first tick immediately, then on interval. */
  start(): void {
    if (this.timer) {
      this.logger.warn('Heartbeat loop already started');
      return;
    }

    this.logger.info({ intervalMs: this.intervalMs }, 'Heartbeat loop started');

    // Run first tick immediately
    this.tick();

    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  /** Stop the heartbeat loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('Heartbeat loop stopped');
    }
  }

  /** Single tick: resolve all statuses and send heartbeats. */
  async tick(): Promise<void> {
    if (this.isRunning) {
      this.logger.debug('Heartbeat tick skipped — previous tick still running');
      return;
    }

    this.isRunning = true;

    try {
      // Build task→session pairs from SessionTracker
      const pairs = this.getTrackedPairs();

      if (pairs.length === 0) {
        this.logger.debug('No tracked tasks, skipping heartbeat');
        return;
      }

      this.logger.debug({ taskCount: pairs.length }, 'Resolving session statuses');

      // Resolve all statuses in one batch (single CLI call + per-task JSONL reads)
      const statuses = await this.resolver.resolveForTasks(pairs);

      // Send heartbeats for non-dead/unknown sessions
      let sent = 0;
      let skipped = 0;

      for (const status of statuses) {
        this.emit('session_state_changed', status);

        if (status.sessionState === 'dead' || status.sessionState === 'unknown') {
          skipped++;
          continue;
        }

        try {
          await this.sendHeartbeat(status);
          sent++;
        } catch (error) {
          this.logger.warn(
            { taskId: status.taskId, error: (error as Error).message },
            'Failed to send heartbeat for task',
          );
        }
      }

      this.logger.info({ sent, skipped, total: statuses.length }, 'Heartbeat tick complete');
    } catch (error) {
      this.logger.error(
        { error: (error as Error).message },
        'Heartbeat tick failed',
      );
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Send a single heartbeat to the API server.
   */
  private async sendHeartbeat(status: TaskSessionStatus): Promise<void> {
    const payload: HeartbeatPayload = {
      sessionKey: status.sessionKey,
      sessionStatus: status.sessionState,
      lastActivityAt: status.lastActivityAt?.toISOString() ?? null,
      details: status.details,
    };

    this.logger.debug(
      { taskId: status.taskId, sessionStatus: status.sessionState },
      'Sending heartbeat',
    );

    await this.clawteamApi.sendHeartbeat(status.taskId, payload);
  }

  /**
   * Extract tracked task→session pairs from SessionTracker.
   */
  private getTrackedPairs(): Array<{ taskId: string; sessionKey: string }> {
    return this.sessionTracker.getAllTracked();
  }
}
