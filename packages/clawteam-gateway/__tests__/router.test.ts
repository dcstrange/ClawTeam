/**
 * Router Tests
 *
 * Tests the pure routing logic (decide) and the execution path (execute).
 */

import type { Task } from '@clawteam/shared/types';
import type { InboxMessage } from '../src/types';
import type { IClawTeamApiClient } from '../src/clients/clawteam-api';
import type { ISessionClient } from '../src/providers/types';
import { TaskRouter } from '../src/routing/router';
import { SessionTracker } from '../src/routing/session-tracker';
import { OpenClawMessageBuilder } from '../src/providers/openclaw/openclaw-message-builder';
import pino from 'pino';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-001',
    fromBotId: 'bot-a',
    toBotId: 'bot-b',
    capability: 'code_review',
    parameters: {},
    status: 'pending',
    priority: 'normal',
    timeoutSeconds: 300,
    retryCount: 0,
    maxRetries: 3,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockClawTeamApi(): jest.Mocked<IClawTeamApiClient> {
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

function createMockOpenClawSession(): jest.Mocked<Required<ISessionClient>> {
  return {
    sendToSession: jest.fn().mockResolvedValue(true),
    sendToMainSession: jest.fn().mockResolvedValue(true),
    isSessionAlive: jest.fn().mockResolvedValue(true),
    restoreSession: jest.fn().mockResolvedValue(false),
    resolveSessionKeyFromId: jest.fn().mockReturnValue(undefined),
    resetMainSession: jest.fn().mockResolvedValue(null),
  };
}

const logger = pino({ level: 'silent' });

describe('TaskRouter', () => {
  let router: TaskRouter;
  let mockApi: jest.Mocked<IClawTeamApiClient>;
  let mockSession: jest.Mocked<Required<ISessionClient>>;
  let sessionTracker: SessionTracker;

  beforeEach(() => {
    mockApi = createMockClawTeamApi();
    mockSession = createMockOpenClawSession();
    sessionTracker = new SessionTracker();

    router = new TaskRouter({
      clawteamApi: mockApi,
      sessionClient: mockSession,
      sessionTracker,
      messageBuilder: new OpenClawMessageBuilder('http://localhost:3100'),
      gatewayUrl: 'http://localhost:3100',
      logger,
    });
  });

  describe('decide()', () => {
    it('routes type=new to main session', () => {
      const task = makeTask({ type: 'new' });
      const decision = router.decide(task);

      expect(decision.action).toBe('send_to_main');
      expect(decision.taskId).toBe('task-001');
      expect(decision.targetSessionKey).toBeUndefined();
    });

    it('routes type=undefined to main session', () => {
      const task = makeTask({ type: undefined });
      const decision = router.decide(task);

      expect(decision.action).toBe('send_to_main');
    });

    it('routes type=sub-task with targetSessionKey to target session', () => {
      const task = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        parameters: { targetSessionKey: 'session-abc' },
      });
      const decision = router.decide(task);

      expect(decision.action).toBe('send_to_session');
      expect(decision.targetSessionKey).toBe('session-abc');
    });

    it('routes type=sub-task without targetSessionKey to main (fallback)', () => {
      const task = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        parameters: {},
      });
      const decision = router.decide(task);

      expect(decision.action).toBe('send_to_main');
      expect(decision.reason).toContain('without targetSessionKey');
    });

    it('routes type=sub-task with parentTaskId to session resolved from sessionTracker', () => {
      sessionTracker.track('parent-001', 'agent:executor:sub:parent');

      const task = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        parameters: {},
      });
      const decision = router.decide(task);

      expect(decision.action).toBe('send_to_session');
      expect(decision.targetSessionKey).toBe('agent:executor:sub:parent');
      expect(decision.reason).toContain('resolved session');
      expect(decision.reason).toContain('parent-001');
    });

    it('routes type=sub-task with parentTaskId to session resolved from retired (completed parent)', () => {
      // Parent was tracked, then untracked (completed) — should still resolve via retired retention
      sessionTracker.track('parent-001', 'agent:executor:sub:parent');
      sessionTracker.untrack('parent-001');

      const task = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        parameters: {},
      });
      const decision = router.decide(task);

      expect(decision.action).toBe('send_to_session');
      expect(decision.targetSessionKey).toBe('agent:executor:sub:parent');
      expect(decision.reason).toContain('resolved session');
      expect(decision.reason).toContain('parent-001');
    });

    it('routes type=sub-task with parentTaskId to main when parent not tracked', () => {
      const task = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-unknown',
        parameters: {},
      });
      const decision = router.decide(task);

      expect(decision.action).toBe('send_to_main');
      expect(decision.reason).toContain('without targetSessionKey');
    });
  });

  describe('execute()', () => {
    it('sends new task to main session', async () => {
      const task = makeTask({ type: 'new' });
      const decision = router.decide(task);
      const result = await router.execute(decision);

      expect(result.success).toBe(true);
      expect(result.action).toBe('send_to_main');
      expect(result.sessionKey).toBe('main');
      expect(mockSession.sendToMainSession).toHaveBeenCalledTimes(1);
      expect(mockSession.sendToMainSession).toHaveBeenCalledWith(
        expect.stringContaining('[ClawTeam Task Received]'),
        'task-001',
      );
    });

    it('sends sub-task to target session when alive', async () => {
      mockSession.isSessionAlive.mockResolvedValue(true);

      const task = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        parameters: { targetSessionKey: 'session-abc' },
      });
      const decision = router.decide(task);
      const result = await router.execute(decision);

      expect(result.success).toBe(true);
      expect(result.action).toBe('send_to_session');
      expect(result.sessionKey).toBe('session-abc');
      expect(mockSession.isSessionAlive).toHaveBeenCalledWith('session-abc');
      expect(mockSession.sendToSession).toHaveBeenCalledWith(
        'session-abc',
        expect.stringContaining('[ClawTeam sub-task Task]'),
      );
    });

    it('falls back to main when target session is expired', async () => {
      mockSession.isSessionAlive.mockResolvedValue(false);

      const task = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        parameters: { targetSessionKey: 'session-dead' },
      });
      const decision = router.decide(task);
      const result = await router.execute(decision);

      expect(result.success).toBe(true);
      expect(result.action).toBe('send_to_main');
      expect(result.fallback).toBe(true);
      expect(result.sessionKey).toBe('main');
      expect(mockSession.sendToMainSession).toHaveBeenCalledWith(
        expect.stringContaining('Spawn a sub-session with this task value'),
        'task-001',
      );
    });

    it('includes parent task context in fallback message', async () => {
      mockSession.isSessionAlive.mockResolvedValue(false);
      mockApi.getTask.mockResolvedValue(
        makeTask({
          id: 'parent-001',
          status: 'completed',
          result: { summary: 'done' },
          capability: 'code_review',
        }),
      );

      const task = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        parameters: { targetSessionKey: 'session-dead' },
      });
      const decision = router.decide(task);
      const result = await router.execute(decision);

      expect(result.success).toBe(true);
      expect(result.fallback).toBe(true);
      expect(mockSession.sendToMainSession).toHaveBeenCalledWith(
        expect.stringContaining('Parent Task Context'),
        'task-001',
      );
    });

    it('tracks session when sending to target session', async () => {
      mockSession.isSessionAlive.mockResolvedValue(true);

      const task = makeTask({
        type: 'sub-task',
        parameters: { targetSessionKey: 'session-abc' },
      });
      const decision = router.decide(task);
      await router.execute(decision);

      expect(sessionTracker.getSessionForTask('task-001')).toBe('session-abc');
    });

    it('returns session_busy when session is alive but send fails (retry on next poll)', async () => {
      mockSession.isSessionAlive.mockResolvedValue(true);
      mockSession.sendToSession.mockResolvedValue(false);

      const task = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        parameters: { targetSessionKey: 'session-flaky' },
      });
      const decision = router.decide(task);
      const result = await router.execute(decision);

      expect(result.success).toBe(false);
      expect(result.action).toBe('send_to_session');
      expect(result.error).toBe('session_busy');
      expect(result.sessionKey).toBe('session-flaky');
      // Should NOT fallback to main — poller will retry
      expect(mockSession.sendToMainSession).not.toHaveBeenCalled();
      // Should NOT attempt restore on alive session
      expect(mockSession.restoreSession).not.toHaveBeenCalled();
    });

    it('does not track session when send fails', async () => {
      mockSession.isSessionAlive.mockResolvedValue(true);
      mockSession.sendToSession.mockResolvedValue(false);

      const task = makeTask({
        type: 'sub-task',
        parameters: { targetSessionKey: 'session-flaky' },
      });
      await router.route(task);

      expect(sessionTracker.getSessionForTask('task-001')).toBeUndefined();
    });

    it('returns failure when send fails', async () => {
      mockSession.sendToMainSession.mockResolvedValue(false);

      const task = makeTask({ type: 'new' });
      const result = await router.route(task);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('handles exceptions gracefully', async () => {
      mockSession.sendToMainSession.mockRejectedValue(new Error('Network error'));

      const task = makeTask({ type: 'new' });
      const result = await router.route(task);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('session restore', () => {
    it('restores session and sends sub-task when target expired', async () => {
      mockSession.isSessionAlive.mockResolvedValue(false);
      mockSession.restoreSession!.mockResolvedValue(true);
      mockSession.sendToSession.mockResolvedValue(true);

      const task = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        parameters: { targetSessionKey: 'session-archived' },
      });
      const result = await router.route(task);

      expect(result.success).toBe(true);
      expect(result.action).toBe('send_to_session');
      expect(result.sessionKey).toBe('session-archived');
      expect(result.fallback).toBeUndefined();
      expect(mockSession.restoreSession).toHaveBeenCalledWith('session-archived');
      expect(mockSession.sendToSession).toHaveBeenCalledWith(
        'session-archived',
        expect.stringContaining('[ClawTeam sub-task Task]'),
      );
    });

    it('falls back when restore succeeds but send fails', async () => {
      mockSession.isSessionAlive.mockResolvedValue(false);
      mockSession.restoreSession!.mockResolvedValue(true);
      mockSession.sendToSession.mockResolvedValue(false);

      const task = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        parameters: { targetSessionKey: 'session-archived' },
      });
      const result = await router.route(task);

      expect(result.success).toBe(true);
      expect(result.action).toBe('send_to_main');
      expect(result.fallback).toBe(true);
      expect(mockSession.restoreSession).toHaveBeenCalledWith('session-archived');
      expect(mockSession.sendToMainSession).toHaveBeenCalledWith(
        expect.stringContaining('Spawn a sub-session with this task value'),
        'task-001',
      );
    });

    it('falls back when restore fails', async () => {
      mockSession.isSessionAlive.mockResolvedValue(false);
      mockSession.restoreSession!.mockResolvedValue(false);

      const task = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        parameters: { targetSessionKey: 'session-gone' },
      });
      const result = await router.route(task);

      expect(result.success).toBe(true);
      expect(result.action).toBe('send_to_main');
      expect(result.fallback).toBe(true);
      expect(mockSession.restoreSession).toHaveBeenCalledWith('session-gone');
    });

    it('handles restore throwing error gracefully', async () => {
      mockSession.isSessionAlive.mockResolvedValue(false);
      mockSession.restoreSession!.mockRejectedValue(new Error('Disk read error'));

      const task = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        parameters: { targetSessionKey: 'session-error' },
      });
      const result = await router.route(task);

      expect(result.success).toBe(true);
      expect(result.action).toBe('send_to_main');
      expect(result.fallback).toBe(true);
      expect(mockSession.restoreSession).toHaveBeenCalledWith('session-error');
      expect(mockSession.sendToMainSession).toHaveBeenCalledWith(
        expect.stringContaining('Spawn a sub-session with this task value'),
        'task-001',
      );
    });
  });

  describe('route() convenience method', () => {
    it('combines decide + execute', async () => {
      const task = makeTask({ type: 'new' });
      const result = await router.route(task);

      expect(result.success).toBe(true);
      expect(result.action).toBe('send_to_main');
    });
  });

  describe('routeMessage() — DM taskId routing', () => {
    it('routes message with taskId to tracked sub-session', async () => {
      // Track a task in a sub-session
      sessionTracker.track('task-active', 'agent:executor:sub:abc');

      // Provide task details from API
      mockApi.getTask.mockResolvedValue(
        makeTask({ id: 'task-active', capability: 'code_review', fromBotId: 'bot-a' }),
      );

      const message: InboxMessage = {
        messageId: 'dm-100',
        fromBotId: 'bot-a',
        toBotId: 'bot-b',
        type: 'direct_message',
        contentType: 'text',
        content: 'Which branch should I review?',
        priority: 'normal',
        taskId: 'task-active',
        traceId: 'trace-100',
        timestamp: new Date().toISOString(),
      };

      const result = await router.routeMessage(message);

      expect(result.success).toBe(true);
      expect(result.action).toBe('send_to_session');
      expect(result.sessionKey).toBe('agent:executor:sub:abc');
      expect(mockSession.sendToSession).toHaveBeenCalledWith(
        'agent:executor:sub:abc',
        expect.stringContaining('[ClawTeam Message -- Task Context]'),
      );
      expect(mockSession.sendToMainSession).not.toHaveBeenCalled();
    });

    it('falls back to main when taskId is not tracked in any session', async () => {
      mockApi.getTask.mockResolvedValue(
        makeTask({ id: 'task-orphan', capability: 'analyze_data' }),
      );

      const message: InboxMessage = {
        messageId: 'dm-101',
        fromBotId: 'bot-x',
        toBotId: 'bot-y',
        type: 'direct_message',
        contentType: 'text',
        content: 'Status?',
        priority: 'normal',
        taskId: 'task-orphan',
        traceId: 'trace-101',
        timestamp: new Date().toISOString(),
      };

      const result = await router.routeMessage(message);

      expect(result.success).toBe(true);
      expect(result.action).toBe('send_to_main');
      expect(result.sessionKey).toBe('main');
      expect(mockSession.sendToMainSession).toHaveBeenCalledWith(
        expect.stringContaining('[ClawTeam Message -- Task Context]'),
      );
      expect(mockSession.sendToSession).not.toHaveBeenCalled();
    });

    it('includes task context in prompt when task is fetched', async () => {
      sessionTracker.track('task-ctx', 'agent:executor:sub:ctx');
      mockApi.getTask.mockResolvedValue(
        makeTask({ id: 'task-ctx', capability: 'code_review' }),
      );

      const message: InboxMessage = {
        messageId: 'dm-102',
        fromBotId: 'bot-sender',
        toBotId: 'bot-receiver',
        type: 'direct_message',
        contentType: 'text',
        content: 'Please clarify scope',
        priority: 'high',
        taskId: 'task-ctx',
        traceId: 'trace-102',
        timestamp: new Date().toISOString(),
      };

      await router.routeMessage(message);

      const prompt = mockSession.sendToSession.mock.calls[0][1];
      expect(prompt).toContain('Task ID: task-ctx');
      expect(prompt).toContain('Capability: code_review');
      expect(prompt).toContain('From Bot: bot-sender');
      expect(prompt).toContain('Please clarify scope');
    });

    it('routes message without taskId to main session (existing behavior)', async () => {
      const message: InboxMessage = {
        messageId: 'dm-103',
        fromBotId: 'bot-plain',
        toBotId: 'bot-b',
        type: 'direct_message',
        contentType: 'text',
        content: 'Hello there',
        priority: 'normal',
        traceId: 'trace-103',
        timestamp: new Date().toISOString(),
      };

      const result = await router.routeMessage(message);

      expect(result.success).toBe(true);
      expect(result.action).toBe('send_to_main');
      expect(result.sessionKey).toBe('main');
      expect(mockSession.sendToMainSession).toHaveBeenCalledWith(
        expect.stringContaining('[ClawTeam Message Received]'),
      );
      expect(mockSession.sendToSession).not.toHaveBeenCalled();
      expect(mockApi.getTask).not.toHaveBeenCalled();
    });

    it('includes taskId in reply template of task-context prompt', async () => {
      sessionTracker.track('task-reply', 'agent:executor:sub:reply');
      mockApi.getTask.mockResolvedValue(
        makeTask({ id: 'task-reply', capability: 'debug' }),
      );

      const message: InboxMessage = {
        messageId: 'dm-104',
        fromBotId: 'bot-asker',
        toBotId: 'bot-doer',
        type: 'direct_message',
        contentType: 'text',
        content: 'What error did you see?',
        priority: 'normal',
        taskId: 'task-reply',
        traceId: 'trace-104',
        timestamp: new Date().toISOString(),
      };

      await router.routeMessage(message);

      const prompt = mockSession.sendToSession.mock.calls[0][1];
      // Reply template should pre-fill taskId to keep the conversation thread
      expect(prompt).toContain('"taskId":"task-reply"');
      expect(prompt).toContain('"toBotId":"bot-asker"');
    });

    it('falls back to main when sub-session send fails', async () => {
      sessionTracker.track('task-fail', 'agent:executor:sub:fail');
      mockApi.getTask.mockResolvedValue(makeTask({ id: 'task-fail' }));
      mockSession.sendToSession.mockResolvedValue(false);

      const message: InboxMessage = {
        messageId: 'dm-105',
        fromBotId: 'bot-a',
        toBotId: 'bot-b',
        type: 'direct_message',
        contentType: 'text',
        content: 'retry test',
        priority: 'normal',
        taskId: 'task-fail',
        traceId: 'trace-105',
        timestamp: new Date().toISOString(),
      };

      const result = await router.routeMessage(message);

      expect(result.success).toBe(true);
      expect(result.action).toBe('send_to_main');
      expect(result.fallback).toBe(true);
      expect(mockSession.sendToSession).toHaveBeenCalled();
      expect(mockSession.sendToMainSession).toHaveBeenCalledWith(
        expect.stringContaining('[ClawTeam Message -- Task Context]'),
      );
    });

    it('continues without task context when getTask fails', async () => {
      sessionTracker.track('task-err', 'agent:executor:sub:err');
      mockApi.getTask.mockRejectedValue(new Error('API down'));

      const message: InboxMessage = {
        messageId: 'dm-106',
        fromBotId: 'bot-a',
        toBotId: 'bot-b',
        type: 'direct_message',
        contentType: 'text',
        content: 'still works?',
        priority: 'normal',
        taskId: 'task-err',
        traceId: 'trace-106',
        timestamp: new Date().toISOString(),
      };

      const result = await router.routeMessage(message);

      expect(result.success).toBe(true);
      expect(result.action).toBe('send_to_session');
      expect(result.sessionKey).toBe('agent:executor:sub:err');
      // Prompt should still contain task ID even without full task details
      const prompt = mockSession.sendToSession.mock.calls[0][1];
      expect(prompt).toContain('Task ID: task-err');
      // Should NOT contain Capability line since task fetch failed
      expect(prompt).not.toContain('Capability:');
    });
  });
});
