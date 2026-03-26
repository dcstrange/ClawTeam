/**
 * Stale Task Recovery Loop Tests
 *
 * Tests: staleness detection, nudge/restore/fallback actions,
 * task cleanup, exhaustion, overlap protection, lifecycle.
 */

import type { IClawTeamApiClient } from '../src/clients/clawteam-api';
import type { ISessionClient } from '../src/providers/types';
import type { TaskSessionStatus, SessionState } from '../src/monitoring/types';
import { StaleTaskRecoveryLoop } from '../src/recovery/stale-task-recovery-loop';
import { SessionStatusResolver } from '../src/monitoring/session-status-resolver';
import { SessionTracker } from '../src/routing/session-tracker';
import { RoutedTasksTracker } from '../src/routing/routed-tasks';
import { OpenClawMessageBuilder } from '../src/providers/openclaw/openclaw-message-builder';
import pino from 'pino';

const GATEWAY_URL = 'http://localhost:3100';

const logger = pino({ level: 'silent' });

function createMockApi(): jest.Mocked<IClawTeamApiClient> {
  return {
    pollPendingTasks: jest.fn().mockResolvedValue([]),
    pollActiveTasks: jest.fn().mockResolvedValue([]),
    pollInbox: jest.fn().mockResolvedValue([]),
    acceptTask: jest.fn().mockResolvedValue(undefined),
    startTask: jest.fn().mockResolvedValue(undefined),
    getTask: jest.fn().mockResolvedValue({
      id: 'task-1',
      capability: 'code_review',
      status: 'processing',
      fromBotId: 'bot-a',
      toBotId: 'bot-b',
      priority: 'normal',
      parameters: {},
    }),
    getBot: jest.fn().mockResolvedValue(null),
    sendHeartbeat: jest.fn().mockResolvedValue(undefined),
    resetTask: jest.fn().mockResolvedValue(true),
    failTask: jest.fn().mockResolvedValue(true),
    cancelTask: jest.fn().mockResolvedValue(true),
    ackMessage: jest.fn().mockResolvedValue(true),
    updateSessionKey: jest.fn().mockResolvedValue(undefined),
    trackSession: jest.fn().mockResolvedValue(true),
    getSessionForTaskBot: jest.fn().mockResolvedValue(null),
    getSessionsForBot: jest.fn().mockResolvedValue([]),
  };
}

function createMockResolver(): jest.Mocked<Pick<SessionStatusResolver, 'resolveForTasks' | 'fetchCliSessions'>> {
  return {
    resolveForTasks: jest.fn().mockResolvedValue([]),
    fetchCliSessions: jest.fn().mockResolvedValue([]),
  };
}

function createMockOpenClaw(): jest.Mocked<Required<ISessionClient>> {
  return {
    sendToSession: jest.fn().mockResolvedValue(true),
    sendToMainSession: jest.fn().mockResolvedValue(true),
    isSessionAlive: jest.fn().mockResolvedValue(true),
    restoreSession: jest.fn().mockResolvedValue(true),
    resolveSessionKeyFromId: jest.fn().mockReturnValue(undefined),
    resetMainSession: jest.fn().mockResolvedValue(null),
  };
}

function makeStatus(
  taskId: string,
  sessionKey: string,
  sessionState: SessionState,
  lastActivityAt: Date | null = null,
): TaskSessionStatus {
  return {
    taskId,
    sessionKey,
    sessionState,
    lastActivityAt,
    details: {
      alive: sessionState !== 'dead',
      jsonlAnalysis: null,
      ageMs: null,
      agentId: 'main',
      sessionId: 'abc',
    },
  };
}

/** 5 minutes ago */
const STALE_TIME = new Date(Date.now() - 6 * 60 * 1000);
/** 1 minute ago (under threshold) */
const RECENT_TIME = new Date(Date.now() - 60 * 1000);

describe('StaleTaskRecoveryLoop', () => {
  let loop: StaleTaskRecoveryLoop;
  let mockApi: jest.Mocked<IClawTeamApiClient>;
  let mockResolver: jest.Mocked<Pick<SessionStatusResolver, 'resolveForTasks' | 'fetchCliSessions'>>;
  let mockOpenClaw: jest.Mocked<Required<ISessionClient>>;
  let tracker: SessionTracker;
  let routedTasks: RoutedTasksTracker;

  beforeEach(() => {
    jest.useFakeTimers();
    mockApi = createMockApi();
    mockResolver = createMockResolver();
    mockOpenClaw = createMockOpenClaw();
    tracker = new SessionTracker();
    routedTasks = new RoutedTasksTracker();

    loop = new StaleTaskRecoveryLoop({
      resolver: mockResolver as any,
      clawteamApi: mockApi,
      sessionClient: mockOpenClaw,
      sessionTracker: tracker,
      messageBuilder: new OpenClawMessageBuilder(GATEWAY_URL),
      routedTasks,
      intervalMs: 120_000,
      stalenessThresholdMs: 300_000, // 5 min
      maxRecoveryAttempts: 3,
      gatewayUrl: 'http://localhost:3100',
      mainSessionKey: 'agent:main:main',
      logger,
    });
  });

  afterEach(() => {
    loop.stop();
    jest.useRealTimers();
  });

  describe('tick()', () => {
    it('skips when no tracked tasks', async () => {
      await loop.tick();

      expect(mockResolver.resolveForTasks).not.toHaveBeenCalled();
      expect(mockOpenClaw.sendToSession).not.toHaveBeenCalled();
    });

    describe('sync untracked tasks', () => {
      it('skips processing tasks without tracker entry (tracked via SPAWN_RESULT)', async () => {
        mockApi.pollActiveTasks.mockResolvedValue([
          {
            id: 'task-new-1',
            status: 'processing',
            capability: 'code_review',
          } as any,
        ]);

        mockResolver.resolveForTasks.mockResolvedValue([]);

        await loop.tick();

        expect(mockApi.pollActiveTasks).toHaveBeenCalled();
        // Processing tasks are tracked via SPAWN_RESULT callback, not sync
        expect(tracker.isTracked('task-new-1')).toBe(false);
      });

      it('does not re-track already tracked tasks', async () => {
        tracker.track('task-1', 'agent:main:subagent:abc');

        mockApi.pollActiveTasks.mockResolvedValue([
          {
            id: 'task-1',
            executorSessionKey: 'agent:main:subagent:different',
            status: 'processing',
            capability: 'code_review',
          } as any,
        ]);

        mockResolver.resolveForTasks.mockResolvedValue([]);

        await loop.tick();

        // Should keep the original session key, not overwrite
        expect(tracker.getSessionForTask('task-1')).toBe('agent:main:subagent:abc');
      });

      it('handles API failure in sync gracefully (logs warn, continues)', async () => {
        mockApi.pollActiveTasks.mockRejectedValue(new Error('Network timeout'));

        tracker.track('task-1', 'agent:main:subagent:abc');
        mockResolver.resolveForTasks.mockResolvedValue([
          makeStatus('task-1', 'agent:main:subagent:abc', 'active', new Date()),
        ]);

        // Should not throw — tick continues with existing tracked tasks
        await loop.tick();

        expect(mockResolver.resolveForTasks).toHaveBeenCalled();
      });

      it('skips accepted tasks without tracker entry (tracked via SPAWN_RESULT)', async () => {
        mockApi.pollActiveTasks.mockResolvedValue([
          {
            id: 'task-accepted-1',
            status: 'accepted',
            capability: 'testing',
          } as any,
        ]);

        mockResolver.resolveForTasks.mockResolvedValue([]);

        await loop.tick();

        // Accepted tasks are tracked via SPAWN_RESULT callback, not sync
        expect(tracker.isTracked('task-accepted-1')).toBe(false);
      });

      it('skips task when raw UUID cannot be resolved', async () => {
        mockOpenClaw.resolveSessionKeyFromId.mockReturnValue(undefined);

        mockApi.pollActiveTasks.mockResolvedValue([
          {
            id: 'task-uuid-bad',
            executorSessionKey: 'some-unknown-uuid',
            status: 'processing',
            capability: 'code_review',
          } as any,
        ]);

        mockResolver.resolveForTasks.mockResolvedValue([]);

        await loop.tick();

        expect(tracker.isTracked('task-uuid-bad')).toBe(false);
      });

      it('skips recent pending tasks without executorSessionKey', async () => {
        mockApi.pollActiveTasks.mockResolvedValue([
          {
            id: 'task-pending-1',
            status: 'pending',
            capability: 'code_review',
            createdAt: new Date().toISOString(), // just created
            // no executorSessionKey
          } as any,
        ]);

        mockResolver.resolveForTasks.mockResolvedValue([]);

        await loop.tick();

        // Recent pending task: not yet stale, should not be tracked
        expect(tracker.isTracked('task-pending-1')).toBe(false);
      });

      it('tracks stale pending task without executorSessionKey against main session', async () => {
        // syncUntrackedTasks uses gateway first-seen time (not task.createdAt).
        // First tick registers firstSeenAt; second tick (after threshold) syncs the task.
        mockApi.pollActiveTasks.mockResolvedValue([
          {
            id: 'task-pending-stale',
            status: 'pending',
            capability: 'code_review',
            createdAt: new Date().toISOString(),
          } as any,
        ]);
        mockApi.getTask.mockResolvedValue({
          id: 'task-pending-stale',
          status: 'pending',
          capability: 'code_review',
          fromBotId: 'bot-a',
          toBotId: 'bot-b',
          priority: 'normal',
          parameters: {},
        } as any);
        mockResolver.resolveForTasks.mockResolvedValue([]);

        // First tick: registers firstSeenAt timestamp
        await loop.tick();
        expect(tracker.isTracked('task-pending-stale')).toBe(false);

        // Advance past staleness threshold (5 min)
        jest.advanceTimersByTime(301_000);

        // Second tick: seenDuration > stalenessThresholdMs → syncs
        await loop.tick();
        expect(tracker.isTracked('task-pending-stale')).toBe(true);
        expect(tracker.getSessionForTask('task-pending-stale')).toBe('agent:main:main');
      });

      it('does not track stale pending task if already tracked', async () => {
        tracker.track('task-pending-1', 'agent:main:subagent:abc');
        const staleCreatedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();

        mockApi.pollActiveTasks.mockResolvedValue([
          {
            id: 'task-pending-1',
            status: 'pending',
            capability: 'code_review',
            createdAt: staleCreatedAt,
          } as any,
        ]);

        mockResolver.resolveForTasks.mockResolvedValue([]);

        await loop.tick();

        // Should keep original session key
        expect(tracker.getSessionForTask('task-pending-1')).toBe('agent:main:subagent:abc');
      });

      it('skips non-pending tasks without executorSessionKey', async () => {
        // accepted/processing tasks without executorSessionKey are unusual
        // but should not be tracked
        mockApi.pollActiveTasks.mockResolvedValue([
          {
            id: 'task-processing-no-key',
            status: 'processing',
            capability: 'code_review',
            createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
            // no executorSessionKey
          } as any,
        ]);

        mockResolver.resolveForTasks.mockResolvedValue([]);

        await loop.tick();

        expect(tracker.isTracked('task-processing-no-key')).toBe(false);
      });

      it('tracks stale pending sub-task with targetSessionKey against that sub-session', async () => {
        // syncUntrackedTasks uses gateway first-seen time (not task.createdAt).
        // First tick registers firstSeenAt; second tick (after threshold) syncs the task.
        mockApi.pollActiveTasks.mockResolvedValue([
          {
            id: 'task-sub-1',
            status: 'pending',
            type: 'sub-task',
            capability: 'code_review',
            createdAt: new Date().toISOString(),
            parentTaskId: 'task-parent-1',
            parameters: { targetSessionKey: 'agent:main:subagent:xyz' },
          } as any,
        ]);
        mockApi.getTask.mockResolvedValue({
          id: 'task-sub-1',
          status: 'pending',
          type: 'sub-task',
          capability: 'code_review',
          fromBotId: 'bot-a',
          toBotId: 'bot-b',
          priority: 'normal',
          parentTaskId: 'task-parent-1',
          parameters: { targetSessionKey: 'agent:main:subagent:xyz' },
        } as any);
        mockResolver.resolveForTasks.mockResolvedValue([]);

        // First tick: registers firstSeenAt
        await loop.tick();
        expect(tracker.isTracked('task-sub-1')).toBe(false);

        // Advance past staleness threshold
        jest.advanceTimersByTime(301_000);

        // Second tick: syncs the stale sub-task
        await loop.tick();
        expect(tracker.isTracked('task-sub-1')).toBe(true);
        expect(tracker.getSessionForTask('task-sub-1')).toBe('agent:main:subagent:xyz');
      });
    });

    it('skips active sessions (not stale)', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'active', new Date()),
      ]);

      await loop.tick();

      // No recovery action: no nudge, no restore, no reset
      expect(mockOpenClaw.sendToSession).not.toHaveBeenCalled();
      expect(mockOpenClaw.sendToMainSession).not.toHaveBeenCalled();
      expect(mockApi.resetTask).not.toHaveBeenCalled();
    });

    it('skips tool_calling sessions under timeout', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      // lastActivityAt = 2 min ago (under default 10 min timeout)
      const recentToolCall = new Date(Date.now() - 2 * 60 * 1000);
      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'tool_calling', recentToolCall),
      ]);

      await loop.tick();

      // No recovery action taken for tool_calling under timeout
      expect(mockOpenClaw.sendToSession).not.toHaveBeenCalled();
      expect(mockApi.resetTask).not.toHaveBeenCalled();
    });

    it('skips waiting sessions', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'waiting', new Date()),
      ]);

      await loop.tick();

      // No recovery action taken for waiting sessions
      expect(mockOpenClaw.sendToSession).not.toHaveBeenCalled();
      expect(mockApi.resetTask).not.toHaveBeenCalled();
    });

    describe('tool_calling timeout', () => {
      let loopWithTimeout: StaleTaskRecoveryLoop;

      beforeEach(() => {
        loopWithTimeout = new StaleTaskRecoveryLoop({
          resolver: mockResolver as any,
          clawteamApi: mockApi,
          sessionClient: mockOpenClaw,
          sessionTracker: tracker,
          messageBuilder: new OpenClawMessageBuilder(GATEWAY_URL),
          routedTasks,
          intervalMs: 120_000,
          stalenessThresholdMs: 300_000,
          toolCallingTimeoutMs: 600_000, // 10 min
          maxRecoveryAttempts: 3,
          gatewayUrl: GATEWAY_URL,
          mainSessionKey: 'agent:main:main',
          logger,
        });
      });

      afterEach(() => {
        loopWithTimeout.stop();
      });

      it('treats tool_calling session stuck beyond timeout as dead', async () => {
        tracker.track('task-1', 'agent:main:subagent:abc');

        // lastActivityAt = 15 min ago (over 10 min timeout)
        const stuckTime = new Date(Date.now() - 15 * 60 * 1000);
        mockResolver.resolveForTasks.mockResolvedValue([
          makeStatus('task-1', 'agent:main:subagent:abc', 'tool_calling', stuckTime),
        ]);

        mockOpenClaw.restoreSession.mockResolvedValue(false);
        mockApi.resetTask.mockResolvedValue(true);

        await loopWithTimeout.tick();

        // Should trigger dead session recovery (restore → reset)
        expect(mockApi.getTask).toHaveBeenCalledWith('task-1');
        expect(mockApi.resetTask).toHaveBeenCalledWith('task-1');
      });

      it('skips tool_calling session with null lastActivityAt', async () => {
        tracker.track('task-1', 'agent:main:subagent:abc');

        mockResolver.resolveForTasks.mockResolvedValue([
          makeStatus('task-1', 'agent:main:subagent:abc', 'tool_calling', null),
        ]);

        await loopWithTimeout.tick();

        // null lastActivityAt means we can't determine duration — no recovery action
        expect(mockOpenClaw.sendToSession).not.toHaveBeenCalled();
        expect(mockApi.resetTask).not.toHaveBeenCalled();
      });

      it('resets task via API when tool_calling session is stuck and restore fails', async () => {
        tracker.track('task-1', 'agent:main:subagent:abc');
        routedTasks.markRouted('task-1');

        const stuckTime = new Date(Date.now() - 15 * 60 * 1000);
        mockResolver.resolveForTasks.mockResolvedValue([
          makeStatus('task-1', 'agent:main:subagent:abc', 'tool_calling', stuckTime),
        ]);

        mockOpenClaw.restoreSession.mockResolvedValue(false);
        mockApi.resetTask.mockResolvedValue(true);

        await loopWithTimeout.tick();

        expect(mockApi.resetTask).toHaveBeenCalledWith('task-1');
        // Untracked from active (retired retention keeps session resolvable)
        expect(tracker.isTracked('task-1')).toBe(false);
        expect(routedTasks.isRouted('task-1')).toBe(false);
      });
    });

    it('skips idle sessions under staleness threshold', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'idle', RECENT_TIME),
      ]);

      await loop.tick();

      // No recovery action: idle but under threshold
      expect(mockOpenClaw.sendToSession).not.toHaveBeenCalled();
      expect(mockApi.resetTask).not.toHaveBeenCalled();
    });

    it('nudges idle session over staleness threshold', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'idle', STALE_TIME),
      ]);

      await loop.tick();

      expect(mockApi.getTask).toHaveBeenCalledWith('task-1');
      expect(mockOpenClaw.sendToSession).toHaveBeenCalledWith(
        'agent:main:subagent:abc',
        expect.stringContaining('[ClawTeam Task Recovery — Nudge]'),
      );
    });

    it('nudges completed session', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'completed'),
      ]);

      await loop.tick();

      expect(mockOpenClaw.sendToSession).toHaveBeenCalledWith(
        'agent:main:subagent:abc',
        expect.stringContaining('Nudge'),
      );
    });

    it('nudges errored session', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'errored'),
      ]);

      await loop.tick();

      expect(mockOpenClaw.sendToSession).toHaveBeenCalledWith(
        'agent:main:subagent:abc',
        expect.stringContaining('errored'),
      );
    });

    it('restores and nudges dead session', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'dead'),
      ]);

      mockOpenClaw.restoreSession.mockResolvedValue(true);

      await loop.tick();

      expect(mockOpenClaw.restoreSession).toHaveBeenCalledWith('agent:main:subagent:abc');
      expect(mockOpenClaw.sendToSession).toHaveBeenCalledWith(
        'agent:main:subagent:abc',
        expect.stringContaining('Nudge'),
      );
    });

    it('resets task via API when dead session restore fails', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');
      routedTasks.markRouted('task-1');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'dead'),
      ]);

      mockOpenClaw.restoreSession.mockResolvedValue(false);
      mockApi.resetTask.mockResolvedValue(true);

      await loop.tick();

      // Should call resetTask instead of sendToMainSession
      expect(mockApi.resetTask).toHaveBeenCalledWith('task-1');
      expect(mockOpenClaw.sendToMainSession).not.toHaveBeenCalled();
      // Should untrack from both session tracker and routed tasks
      // (getSessionForTask still resolves via retired retention)
      expect(tracker.isTracked('task-1')).toBe(false);
      expect(routedTasks.isRouted('task-1')).toBe(false);
    });

    it('skips resetTask for pending task in dead session and untracks directly', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');
      routedTasks.markRouted('task-1');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'dead'),
      ]);

      mockOpenClaw.restoreSession.mockResolvedValue(false);
      mockApi.getTask.mockResolvedValue({
        id: 'task-1',
        capability: 'code_review',
        status: 'pending',
        fromBotId: 'bot-a',
        toBotId: 'bot-b',
        priority: 'normal',
        parameters: {},
      } as any);

      await loop.tick();

      // Should NOT call resetTask (pending tasks would 409)
      expect(mockApi.resetTask).not.toHaveBeenCalled();
      // Should NOT send fallback to main
      expect(mockOpenClaw.sendToMainSession).not.toHaveBeenCalled();
      // Should untrack so poller re-routes (retired retention keeps session resolvable)
      expect(tracker.isTracked('task-1')).toBe(false);
      expect(routedTasks.isRouted('task-1')).toBe(false);
    });

    it('sends normal-format fallback when both restore and API reset fail', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'dead'),
      ]);

      mockOpenClaw.restoreSession.mockResolvedValue(false);
      mockApi.resetTask.mockResolvedValue(false);

      await loop.tick();

      // Should fall back to sending message to main session
      expect(mockOpenClaw.sendToMainSession).toHaveBeenCalled();
      // But the message should use [ClawTeam Task Received] format, NOT [Recovery — Fallback]
      const msg = mockOpenClaw.sendToMainSession.mock.calls[0][0];
      expect(msg).toContain('[ClawTeam Task Received]');
      expect(msg).not.toContain('Recovery');
      expect(msg).not.toContain('Fallback');
      expect(msg).not.toContain('died');
      // Should contain task parameters for normal processing
      expect(msg).toContain('Capability: code_review');
      expect(msg).toContain('Task ID: task-1');
      // Should untrack from active (retired retention keeps session resolvable)
      expect(tracker.isTracked('task-1')).toBe(false);
    });

    it('nudges idle session when task is pending (not terminal)', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'idle', STALE_TIME),
      ]);

      mockApi.getTask.mockResolvedValue({
        id: 'task-1',
        capability: 'code_review',
        status: 'pending',
      } as any);

      await loop.tick();

      // Should nudge, not untrack
      expect(mockOpenClaw.sendToSession).toHaveBeenCalledWith(
        'agent:main:subagent:abc',
        expect.stringContaining('[ClawTeam Task Recovery — Nudge]'),
      );
      // Task should still be tracked
      expect(tracker.getSessionForTask('task-1')).toBe('agent:main:subagent:abc');
    });

    it('untracks task that is no longer processing', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'idle', STALE_TIME),
      ]);

      mockApi.getTask.mockResolvedValue({
        id: 'task-1',
        status: 'completed',
      } as any);

      await loop.tick();

      // Removed from active tracking (still in retired for sub-task resolution)
      expect(tracker.isTracked('task-1')).toBe(false);
      expect(tracker.getSessionForTask('task-1')).toBe('agent:main:subagent:abc');
      expect(mockOpenClaw.sendToSession).not.toHaveBeenCalled();
    });

    it('untracks task that is not found', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'errored'),
      ]);

      mockApi.getTask.mockResolvedValue(null);

      await loop.tick();

      // Removed from active tracking (still in retired for sub-task resolution)
      expect(tracker.isTracked('task-1')).toBe(false);
      expect(tracker.getSessionForTask('task-1')).toBe('agent:main:subagent:abc');
      expect(mockOpenClaw.sendToSession).not.toHaveBeenCalled();
    });

    it('skips when recovery attempts exhausted', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'idle', STALE_TIME),
      ]);

      // Exhaust attempts (3 ticks)
      for (let i = 0; i < 3; i++) {
        await loop.tick();
      }

      mockOpenClaw.sendToSession.mockClear();
      mockApi.getTask.mockClear();

      // 4th tick should skip
      await loop.tick();

      // getTask is still called to check if task is still processing
      expect(mockApi.getTask).toHaveBeenCalled();
      // But no nudge should be sent
      expect(mockOpenClaw.sendToSession).not.toHaveBeenCalled();
    });

    it('continues processing other tasks when one fails', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');
      tracker.track('task-2', 'agent:main:subagent:def');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'idle', STALE_TIME),
        makeStatus('task-2', 'agent:main:subagent:def', 'idle', STALE_TIME),
      ]);

      mockApi.getTask
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ id: 'task-2', capability: 'test', status: 'processing' } as any);

      await loop.tick();

      // task-2 should still get nudged even though task-1 failed
      expect(mockOpenClaw.sendToSession).toHaveBeenCalledWith(
        'agent:main:subagent:def',
        expect.stringContaining('Nudge'),
      );
    });
  });

  describe('dead session recovery flow', () => {
    it('tries restore → resetTask → fallback in order', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'dead'),
      ]);

      // Restore fails, reset succeeds
      mockOpenClaw.restoreSession.mockResolvedValue(false);
      mockApi.resetTask.mockResolvedValue(true);

      await loop.tick();

      expect(mockOpenClaw.restoreSession).toHaveBeenCalledWith('agent:main:subagent:abc');
      expect(mockApi.resetTask).toHaveBeenCalledWith('task-1');
      expect(mockOpenClaw.sendToMainSession).not.toHaveBeenCalled();
    });

    it('clears routedTasks entry on successful API reset', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');
      routedTasks.markRouted('task-1');
      expect(routedTasks.isRouted('task-1')).toBe(true);

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'dead'),
      ]);

      mockOpenClaw.restoreSession.mockResolvedValue(false);
      mockApi.resetTask.mockResolvedValue(true);

      await loop.tick();

      expect(routedTasks.isRouted('task-1')).toBe(false);
    });

    it('does not clear routedTasks when API reset fails', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');
      routedTasks.markRouted('task-1');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'dead'),
      ]);

      mockOpenClaw.restoreSession.mockResolvedValue(false);
      mockApi.resetTask.mockResolvedValue(false);

      await loop.tick();

      // routedTasks should not be cleared since we sent fallback instead
      expect(routedTasks.isRouted('task-1')).toBe(true);
    });
  });

  describe('nudge message format', () => {
    it('includes task details and completion URL', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'idle', STALE_TIME),
      ]);

      mockApi.getTask.mockResolvedValue({
        id: 'task-1',
        capability: 'code_review',
        status: 'processing',
      } as any);

      await loop.tick();

      const msg = mockOpenClaw.sendToSession.mock.calls[0][1];
      expect(msg).toContain('Task ID: task-1');
      expect(msg).toContain('Capability: code_review');
      expect(msg).toContain('Recovery Attempt: 1/3');
      expect(msg).toContain('POST http://localhost:3100/gateway/tasks/task-1/complete');
    });
  });

  describe('fallback message format', () => {
    it('uses [ClawTeam Task Received] format with sub-session instructions', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'dead'),
      ]);

      mockOpenClaw.restoreSession.mockResolvedValue(false);
      mockApi.resetTask.mockResolvedValue(false);
      mockApi.getTask.mockResolvedValue({
        id: 'task-1',
        capability: 'code_review',
        status: 'processing',
        fromBotId: 'bot-originator',
        toBotId: 'bot-executor',
        priority: 'high',
        type: 'new',
        parameters: { repo: 'my-repo', branch: 'main' },
      } as any);

      await loop.tick();

      const msg = mockOpenClaw.sendToMainSession.mock.calls[0][0];
      expect(msg).toContain('[ClawTeam Task Received]');
      expect(msg).toContain('From Bot: bot-originator');
      expect(msg).toContain('Priority: high');
      expect(msg).toContain('SUB-SESSION TASK DETAILS');
      expect(msg).toContain('my-repo');
      expect(msg).toContain('DO NOT call any /tasks/ API endpoints yourself');
    });
  });

  describe('overlap protection', () => {
    it('skips tick if previous tick is still running', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      let resolveFirst: () => void;
      const firstTickPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      mockResolver.resolveForTasks.mockImplementationOnce(async () => {
        await firstTickPromise;
        return [];
      });

      const tick1 = loop.tick();
      await loop.tick(); // should skip

      resolveFirst!();
      await tick1;

      expect(mockResolver.resolveForTasks).toHaveBeenCalledTimes(1);
    });
  });

  describe('start/stop', () => {
    it('starts and stops cleanly', () => {
      loop.start();
      loop.start(); // double start — no throw
      loop.stop();
      loop.stop(); // double stop — no throw
    });
  });

  describe('idle session with null lastActivityAt', () => {
    it('treats idle session with null lastActivityAt as stale', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-1', 'agent:main:subagent:abc', 'idle', null),
      ]);

      await loop.tick();

      // null lastActivityAt means we can't determine idle duration,
      // so it should proceed to check the task
      expect(mockApi.getTask).toHaveBeenCalledWith('task-1');
    });
  });
});
