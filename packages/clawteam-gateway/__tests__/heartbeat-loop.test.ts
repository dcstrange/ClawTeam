/**
 * Heartbeat Loop Tests
 *
 * Tests: tick sending/skipping, API error tolerance, overlap protection.
 */

import type { IClawTeamApiClient } from '../src/clients/clawteam-api';
import type { HeartbeatPayload } from '../src/monitoring/types';
import { HeartbeatLoop } from '../src/monitoring/heartbeat-loop';
import type { ISessionResolver } from '../src/providers/types';
import { SessionTracker } from '../src/routing/session-tracker';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function createMockApi(): jest.Mocked<IClawTeamApiClient> {
  return {
    pollPendingTasks: jest.fn().mockResolvedValue([]),
    pollActiveTasks: jest.fn().mockResolvedValue([]),
    pollInbox: jest.fn().mockResolvedValue([]),
    acceptTask: jest.fn().mockResolvedValue(undefined),
    startTask: jest.fn().mockResolvedValue(undefined),
    getTask: jest.fn().mockResolvedValue(null),
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

function createMockResolver(): jest.Mocked<ISessionResolver> {
  return {
    resolveAll: jest.fn().mockResolvedValue([]),
    resolveForTasks: jest.fn().mockResolvedValue([]),
  };
}

describe('HeartbeatLoop', () => {
  let loop: HeartbeatLoop;
  let mockApi: jest.Mocked<IClawTeamApiClient>;
  let mockResolver: jest.Mocked<ISessionResolver>;
  let tracker: SessionTracker;

  beforeEach(() => {
    jest.useFakeTimers();
    mockApi = createMockApi();
    mockResolver = createMockResolver();
    tracker = new SessionTracker();

    loop = new HeartbeatLoop({
      resolver: mockResolver as any,
      clawteamApi: mockApi,
      sessionTracker: tracker,
      intervalMs: 30_000,
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
      expect(mockApi.sendHeartbeat).not.toHaveBeenCalled();
    });

    it('resolves and sends heartbeats for tracked tasks', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');
      tracker.track('task-2', 'agent:main:subagent:def');

      mockResolver.resolveForTasks.mockResolvedValue([
        {
          taskId: 'task-1',
          sessionKey: 'agent:main:subagent:abc',
          sessionState: 'active',
          lastActivityAt: new Date('2026-01-01'),
          details: {
            alive: true,
            jsonlAnalysis: null,
            ageMs: 5000,
            agentId: 'main',
            sessionId: 'abc',
          },
        },
        {
          taskId: 'task-2',
          sessionKey: 'agent:main:subagent:def',
          sessionState: 'tool_calling',
          lastActivityAt: new Date('2026-01-01'),
          details: {
            alive: true,
            jsonlAnalysis: null,
            ageMs: 3000,
            agentId: 'main',
            sessionId: 'def',
          },
        },
      ]);

      await loop.tick();

      expect(mockResolver.resolveForTasks).toHaveBeenCalledTimes(1);
      expect(mockApi.sendHeartbeat).toHaveBeenCalledTimes(2);
      expect(mockApi.sendHeartbeat).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ sessionStatus: 'active' }),
      );
      expect(mockApi.sendHeartbeat).toHaveBeenCalledWith(
        'task-2',
        expect.objectContaining({ sessionStatus: 'tool_calling' }),
      );
    });

    it('skips dead sessions', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        {
          taskId: 'task-1',
          sessionKey: 'agent:main:subagent:abc',
          sessionState: 'dead',
          lastActivityAt: null,
          details: {
            alive: false,
            jsonlAnalysis: null,
            ageMs: null,
            agentId: 'main',
            sessionId: 'abc',
          },
        },
      ]);

      await loop.tick();

      expect(mockApi.sendHeartbeat).not.toHaveBeenCalled();
    });

    it('skips unknown sessions', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        {
          taskId: 'task-1',
          sessionKey: 'agent:main:subagent:abc',
          sessionState: 'unknown',
          lastActivityAt: null,
          details: {
            alive: false,
            jsonlAnalysis: null,
            ageMs: null,
            agentId: 'main',
            sessionId: null,
          },
        },
      ]);

      await loop.tick();

      expect(mockApi.sendHeartbeat).not.toHaveBeenCalled();
    });

    it('continues sending after individual heartbeat failure', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');
      tracker.track('task-2', 'agent:main:subagent:def');

      mockResolver.resolveForTasks.mockResolvedValue([
        {
          taskId: 'task-1',
          sessionKey: 'agent:main:subagent:abc',
          sessionState: 'active',
          lastActivityAt: new Date(),
          details: { alive: true, jsonlAnalysis: null, ageMs: 1000, agentId: 'main', sessionId: 'abc' },
        },
        {
          taskId: 'task-2',
          sessionKey: 'agent:main:subagent:def',
          sessionState: 'waiting',
          lastActivityAt: new Date(),
          details: { alive: true, jsonlAnalysis: null, ageMs: 2000, agentId: 'main', sessionId: 'def' },
        },
      ]);

      // First heartbeat fails
      mockApi.sendHeartbeat
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(undefined);

      await loop.tick();

      // Should still have tried both
      expect(mockApi.sendHeartbeat).toHaveBeenCalledTimes(2);
    });

    it('handles resolver failure gracefully', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockRejectedValue(new Error('CLI crashed'));

      // Should not throw
      await expect(loop.tick()).resolves.toBeUndefined();
      expect(mockApi.sendHeartbeat).not.toHaveBeenCalled();
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

      // Start first tick (will block)
      const tick1 = loop.tick();

      // Start second tick immediately — should skip
      await loop.tick();

      // Resolve first tick
      resolveFirst!();
      await tick1;

      // resolveForTasks should only have been called once (first tick)
      expect(mockResolver.resolveForTasks).toHaveBeenCalledTimes(1);
    });
  });

  describe('start/stop', () => {
    it('starts and stops cleanly', () => {
      loop.start();

      // Should not throw on double start
      loop.start();

      loop.stop();

      // Should not throw on double stop
      loop.stop();
    });
  });

  describe('heartbeat payload format', () => {
    it('sends correct payload structure', async () => {
      tracker.track('task-1', 'agent:bob:subagent:xyz');

      const testDate = new Date('2026-02-01T12:00:00Z');
      mockResolver.resolveForTasks.mockResolvedValue([
        {
          taskId: 'task-1',
          sessionKey: 'agent:bob:subagent:xyz',
          sessionState: 'tool_calling',
          lastActivityAt: testDate,
          details: {
            alive: true,
            jsonlAnalysis: {
              lastMessageRole: 'assistant',
              lastStopReason: 'toolUse',
              lastErrorMessage: null,
              toolCallCount: 3,
              messageCount: 10,
              model: 'claude-3-opus',
              provider: 'anthropic',
            },
            ageMs: 5000,
            agentId: 'bob',
            sessionId: 'xyz',
          },
        },
      ]);

      await loop.tick();

      expect(mockApi.sendHeartbeat).toHaveBeenCalledWith('task-1', {
        sessionKey: 'agent:bob:subagent:xyz',
        sessionStatus: 'tool_calling',
        lastActivityAt: testDate.toISOString(),
        details: {
          alive: true,
          jsonlAnalysis: {
            lastMessageRole: 'assistant',
            lastStopReason: 'toolUse',
            lastErrorMessage: null,
            toolCallCount: 3,
            messageCount: 10,
            model: 'claude-3-opus',
            provider: 'anthropic',
          },
          ageMs: 5000,
          agentId: 'bob',
          sessionId: 'xyz',
        },
      });
    });

    it('sends null lastActivityAt when not available', async () => {
      tracker.track('task-1', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        {
          taskId: 'task-1',
          sessionKey: 'agent:main:subagent:abc',
          sessionState: 'idle',
          lastActivityAt: null,
          details: { alive: true, jsonlAnalysis: null, ageMs: null, agentId: 'main', sessionId: 'abc' },
        },
      ]);

      await loop.tick();

      expect(mockApi.sendHeartbeat).toHaveBeenCalledWith('task-1', expect.objectContaining({
        lastActivityAt: null,
      }));
    });
  });
});
