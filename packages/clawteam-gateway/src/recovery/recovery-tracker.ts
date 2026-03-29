/**
 * Recovery Attempt Tracker
 *
 * In-memory per-task recovery attempt counter.
 * Tracks how many times we've tried to recover each task,
 * so we can stop after maxAttempts and let the API's
 * TimeoutDetector handle it.
 */

import type { SessionState } from '../monitoring/types.js';
import type { RecoveryRecord } from './types.js';

export class RecoveryAttemptTracker {
  private readonly records = new Map<string, RecoveryRecord>();
  private readonly maxAttempts: number;

  constructor(maxAttempts: number) {
    this.maxAttempts = maxAttempts;
  }

  /** Maximum recovery attempts allowed per task. */
  get maxAttemptsValue(): number {
    return this.maxAttempts;
  }

  /** Record a recovery attempt for a task */
  recordAttempt(taskId: string, sessionState: SessionState): void {
    const existing = this.records.get(taskId);
    this.records.set(taskId, {
      attempts: (existing?.attempts ?? 0) + 1,
      lastAttemptAt: Date.now(),
      lastSessionState: sessionState,
    });
  }

  /** Check if recovery attempts are exhausted for a task */
  isExhausted(taskId: string): boolean {
    const record = this.records.get(taskId);
    return (record?.attempts ?? 0) >= this.maxAttempts;
  }

  /** Get the recovery record for a task */
  getRecord(taskId: string): RecoveryRecord | undefined {
    return this.records.get(taskId);
  }

  /** Remove tracking for a task (e.g. when completed) */
  remove(taskId: string): void {
    this.records.delete(taskId);
  }

  /** Get stats for logging */
  getStats(): { tracked: number; exhausted: number } {
    let exhausted = 0;
    for (const record of this.records.values()) {
      if (record.attempts >= this.maxAttempts) exhausted++;
    }
    return { tracked: this.records.size, exhausted };
  }
}
