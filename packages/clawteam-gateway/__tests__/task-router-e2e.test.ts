/**
 * TaskRouter Integration Test (Unified Inbox)
 *
 * Tests the full poll → route → verify cycle with all components wired together.
 * Uses mock API and mock session client to verify routing decisions end-to-end.
 *
 * The poller now polls GET /messages/inbox and dispatches by message type:
 * - task_notification → getTask() → router.route(task)
 * - direct_message   → router.routeMessage(message)
 */

import type { Task } from '@clawteam/shared/types';
import type { IClawTeamApiClient } from '../src/clients/clawteam-api';
import type { ISessionClient } from '../src/providers/types';
import type { InboxMessage } from '../src/types';
import { TaskRouter } from '../src/routing/router';
import { SessionTracker } from '../src/routing/session-tracker';
import { TaskPollingLoop } from '../src/polling/task-poller';
import pino from 'pino';

// ── Test Helpers ──────────────────────────────────────────────

let taskIdCounter = 0;

function makeTask(overrides: Partial<Task> = {}): Task {
  taskIdCounter++;
  return {
    id: `task-${String(taskIdCounter).padStart(3, '0')}`,
    fromBotId: 'originator-bot',
    toBotId: 'executor-bot',
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

function taskToInboxMessage(task: Task): InboxMessage {
  return {
    messageId: `msg-${task.id}`,
    fromBotId: task.fromBotId,
    toBotId: task.toBotId,
    type: 'task_notification',
    contentType: 'json',
    content: {
      taskId: task.id,
      capability: task.capability,
      parameters: task.parameters,
      taskType: task.type || 'new',
      parentTaskId: task.parentTaskId,
    },
    priority: task.priority,
    taskId: task.id,
    traceId: `trace-${task.id}`,
    timestamp: new Date().toISOString(),
  };
}

/** Mock API that serves inbox messages and resolves tasks by ID */
function createMockApi(pendingTasks: Task[] = []): jest.Mocked<IClawTeamApiClient> {
  const taskMap = new Map(pendingTasks.map((t) => [t.id, t]));
  const inboxMessages = pendingTasks.map(taskToInboxMessage);

  return {
    pollPendingTasks: jest.fn().mockResolvedValue([...pendingTasks]),
    pollActiveTasks: jest.fn().mockResolvedValue([]),
    pollInbox: jest.fn().mockImplementation(async () => {
      // Consume-style: return all then empty on next call
      const msgs = [...inboxMessages];
      inboxMessages.length = 0;
      return msgs;
    }),
    acceptTask: jest.fn().mockResolvedValue(undefined),
    startTask: jest.fn().mockResolvedValue(undefined),
    getTask: jest.fn().mockImplementation(async (taskId: string) => {
      return taskMap.get(taskId) || null;
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

/** Mock session client that records all messages sent */
interface SentMessage {
  target: 'main' | string;
  message: string;
}

function createMockSessionClient(): jest.Mocked<ISessionClient> & { sentMessages: SentMessage[] } {
  const sentMessages: SentMessage[] = [];
  const mock = {
    sentMessages,
    sendToSession: jest.fn().mockImplementation(async (sessionKey: string, message: string) => {
      sentMessages.push({ target: sessionKey, message });
      return true;
    }),
    sendToMainSession: jest.fn().mockImplementation(async (message: string) => {
      sentMessages.push({ target: 'main', message });
      return true;
    }),
    isSessionAlive: jest.fn().mockResolvedValue(true),
  };
  return mock;
}

const logger = pino({ level: 'silent' });

// ── Integration Tests ─────────────────────────────────────────

describe('TaskRouter Integration', () => {
  beforeEach(() => {
    taskIdCounter = 0;
  });

  describe('Full poll → route cycle', () => {
    it('routes a single new task to main session', async () => {
      const task = makeTask({ type: 'new', capability: 'code_review' });
      const mockApi = createMockApi([task]);
      const mockSession = createMockSessionClient();
      const sessionTracker = new SessionTracker();

      const router = new TaskRouter({
        clawteamApi: mockApi,
        sessionClient: mockSession,
        sessionTracker,
        gatewayUrl: 'http://localhost:3100',
        logger,
      });

      const poller = new TaskPollingLoop({
        clawteamApi: mockApi,
        router,
        pollIntervalMs: 60_000,
        pollLimit: 10,
        logger,
      });

      await poller.pollOnce();

      // Verify inbox was polled
      expect(mockApi.pollInbox).toHaveBeenCalledWith(10);

      // Verify task was fetched
      expect(mockApi.getTask).toHaveBeenCalledWith(task.id);

      // Verify message was sent to main session
      expect(mockSession.sendToMainSession).toHaveBeenCalledTimes(1);
      expect(mockSession.sentMessages).toHaveLength(1);
      expect(mockSession.sentMessages[0].target).toBe('main');
      expect(mockSession.sentMessages[0].message).toContain('[ClawTeam Task Received]');
      expect(mockSession.sentMessages[0].message).toContain(task.id);
      expect(mockSession.sentMessages[0].message).toContain('code_review');

      // ACK should be called after successful routing
      expect(mockApi.ackMessage).toHaveBeenCalledWith(`msg-${task.id}`);
    });

    it('routes multiple tasks of different types in one poll cycle', async () => {
      const newTask = makeTask({ type: 'new', capability: 'analyze_data' });
      const subTask1 = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        capability: 'code_review',
        parameters: { targetSessionKey: 'agent:executor:sub:abc123' },
      });
      const subTask2 = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-002',
        capability: 'generate_report',
        parameters: { targetSessionKey: 'agent:executor:sub:def456' },
      });

      const mockApi = createMockApi([newTask, subTask1, subTask2]);
      const mockSession = createMockSessionClient();
      const sessionTracker = new SessionTracker();

      const router = new TaskRouter({
        clawteamApi: mockApi,
        sessionClient: mockSession,
        sessionTracker,
        gatewayUrl: 'http://localhost:3100',
        logger,
      });

      const poller = new TaskPollingLoop({
        clawteamApi: mockApi,
        router,
        pollIntervalMs: 60_000,
        pollLimit: 10,
        logger,
      });

      await poller.pollOnce();

      // Total: 1 main + 2 session
      expect(mockSession.sentMessages).toHaveLength(3);

      // New task → main session
      const mainMessages = mockSession.sentMessages.filter((m: SentMessage) => m.target === 'main');
      expect(mainMessages).toHaveLength(1);
      expect(mainMessages[0].message).toContain('analyze_data');

      // Sub-task 1 → target session
      const subTask1Messages = mockSession.sentMessages.filter(
        (m: SentMessage) => m.target === 'agent:executor:sub:abc123',
      );
      expect(subTask1Messages).toHaveLength(1);
      expect(subTask1Messages[0].message).toContain('[ClawTeam sub-task Task]');
      expect(subTask1Messages[0].message).toContain('parent-001');

      // Sub-task 2 → target session
      const subTask2Messages = mockSession.sentMessages.filter(
        (m: SentMessage) => m.target === 'agent:executor:sub:def456',
      );
      expect(subTask2Messages).toHaveLength(1);
      expect(subTask2Messages[0].message).toContain('[ClawTeam sub-task Task]');
      expect(subTask2Messages[0].message).toContain('parent-002');
    });

    it('falls back to main when target session is expired', async () => {
      const parentTask = makeTask({
        id: 'parent-001',
        type: 'new',
        capability: 'code_review',
        status: 'completed',
        result: { summary: 'Looks good, minor issues found' },
      });

      const subTask = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        capability: 'code_review',
        parameters: { targetSessionKey: 'agent:executor:sub:expired' },
      });

      const mockApi = createMockApi([subTask]);
      // Override getTask to also return parent task
      mockApi.getTask.mockImplementation(async (taskId: string) => {
        if (taskId === subTask.id) return subTask;
        if (taskId === 'parent-001') return parentTask;
        return null;
      });

      const mockSession = createMockSessionClient();
      mockSession.isSessionAlive.mockResolvedValue(false); // Session expired

      const sessionTracker = new SessionTracker();
      const router = new TaskRouter({
        clawteamApi: mockApi,
        sessionClient: mockSession,
        sessionTracker,
        gatewayUrl: 'http://localhost:3100',
        logger,
      });

      const poller = new TaskPollingLoop({
        clawteamApi: mockApi,
        router,
        pollIntervalMs: 60_000,
        pollLimit: 10,
        logger,
      });

      await poller.pollOnce();

      // Should check if session is alive
      expect(mockSession.isSessionAlive).toHaveBeenCalledWith('agent:executor:sub:expired');

      // Should fall back to main session
      expect(mockSession.sendToMainSession).toHaveBeenCalledTimes(1);
      expect(mockSession.sendToSession).not.toHaveBeenCalled();

      // Fallback message should contain task info and sub-session instructions
      const message = mockSession.sentMessages[0].message;
      expect(message).toContain('[ClawTeam Task Received]');
      expect(message).toContain('Spawn a sub-session with this task value');
      expect(message).toContain('parent-001');
      expect(message).toContain('Parent Task Context');
      expect(message).toContain('code_review');
    });

    it('routes direct_message to main session via routeMessage', async () => {
      const mockApi = createMockApi([]);
      const dmMessage: InboxMessage = {
        messageId: 'dm-001',
        fromBotId: 'bot-sender',
        toBotId: 'bot-receiver',
        type: 'direct_message',
        contentType: 'text',
        content: 'Hello, can you help?',
        priority: 'high',
        traceId: 'trace-dm-001',
        timestamp: new Date().toISOString(),
      };
      mockApi.pollInbox.mockResolvedValueOnce([dmMessage]);

      const mockSession = createMockSessionClient();

      const router = new TaskRouter({
        clawteamApi: mockApi,
        sessionClient: mockSession,
        sessionTracker: new SessionTracker(),
        gatewayUrl: 'http://localhost:3100',
        logger,
      });

      const poller = new TaskPollingLoop({
        clawteamApi: mockApi,
        router,
        pollIntervalMs: 60_000,
        pollLimit: 10,
        logger,
      });

      await poller.pollOnce();

      expect(mockSession.sendToMainSession).toHaveBeenCalledTimes(1);
      const message = mockSession.sentMessages[0].message;
      expect(message).toContain('[ClawTeam Message Received]');
      expect(message).toContain('From Bot: bot-sender');
      expect(message).toContain('Hello, can you help?');

      // ACK should be called after successful delivery
      expect(mockApi.ackMessage).toHaveBeenCalledWith('dm-001');
    });
  });

  describe('Deduplication across poll cycles', () => {
    it('inbox is consume-based so second poll returns empty', async () => {
      const task = makeTask({ type: 'new' });
      const mockApi = createMockApi([task]);
      const mockSession = createMockSessionClient();

      const router = new TaskRouter({
        clawteamApi: mockApi,
        sessionClient: mockSession,
        sessionTracker: new SessionTracker(),
        gatewayUrl: 'http://localhost:3100',
        logger,
      });

      const poller = new TaskPollingLoop({
        clawteamApi: mockApi,
        router,
        pollIntervalMs: 60_000,
        pollLimit: 10,
        logger,
      });

      // First poll — task gets routed
      await poller.pollOnce();
      expect(mockSession.sendToMainSession).toHaveBeenCalledTimes(1);

      // Second poll — inbox consumed, returns empty
      await poller.pollOnce();
      expect(mockSession.sendToMainSession).toHaveBeenCalledTimes(1); // Still 1
    });
  });

  describe('Error resilience', () => {
    it('continues routing remaining messages when one fails', async () => {
      const task1 = makeTask({ type: 'new', capability: 'task_a' });
      const task2 = makeTask({ type: 'new', capability: 'task_b' });
      const task3 = makeTask({ type: 'new', capability: 'task_c' });

      const mockApi = createMockApi([task1, task2, task3]);
      const mockSession = createMockSessionClient();

      // Fail on second call only
      let callCount = 0;
      mockSession.sendToMainSession.mockImplementation(async (message: string) => {
        callCount++;
        if (callCount === 2) return false; // task2 fails
        mockSession.sentMessages.push({ target: 'main', message });
        return true;
      });

      const router = new TaskRouter({
        clawteamApi: mockApi,
        sessionClient: mockSession,
        sessionTracker: new SessionTracker(),
        gatewayUrl: 'http://localhost:3100',
        logger,
      });

      const poller = new TaskPollingLoop({
        clawteamApi: mockApi,
        router,
        pollIntervalMs: 60_000,
        pollLimit: 10,
        logger,
      });

      await poller.pollOnce();

      // All 3 tasks attempted
      expect(mockSession.sendToMainSession).toHaveBeenCalledTimes(3);

      // task1 and task3 succeeded
      expect(mockSession.sentMessages).toHaveLength(2);
      expect(mockSession.sentMessages[0].message).toContain('task_a');
      expect(mockSession.sentMessages[1].message).toContain('task_c');
    });

    it('handles API poll failure gracefully', async () => {
      const mockApi = createMockApi([]);
      mockApi.pollInbox.mockRejectedValue(new Error('Connection refused'));

      const mockSession = createMockSessionClient();

      const router = new TaskRouter({
        clawteamApi: mockApi,
        sessionClient: mockSession,
        sessionTracker: new SessionTracker(),
        gatewayUrl: 'http://localhost:3100',
        logger,
      });

      const poller = new TaskPollingLoop({
        clawteamApi: mockApi,
        router,
        pollIntervalMs: 60_000,
        pollLimit: 10,
        logger,
      });

      // Should not throw
      await poller.pollOnce();

      expect(mockSession.sendToMainSession).not.toHaveBeenCalled();
    });

    it('handles empty poll results', async () => {
      const mockApi = createMockApi([]);
      const mockSession = createMockSessionClient();

      const router = new TaskRouter({
        clawteamApi: mockApi,
        sessionClient: mockSession,
        sessionTracker: new SessionTracker(),
        gatewayUrl: 'http://localhost:3100',
        logger,
      });

      const poller = new TaskPollingLoop({
        clawteamApi: mockApi,
        router,
        pollIntervalMs: 60_000,
        pollLimit: 10,
        logger,
      });

      await poller.pollOnce();

      expect(mockSession.sendToMainSession).not.toHaveBeenCalled();
      expect(mockSession.sendToSession).not.toHaveBeenCalled();
    });
  });

  describe('Session tracking', () => {
    it('tracks session assignments for routed sub-tasks', async () => {
      const subTask = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        parameters: { targetSessionKey: 'agent:executor:sub:abc' },
      });

      const mockApi = createMockApi([subTask]);
      const mockSession = createMockSessionClient();
      const sessionTracker = new SessionTracker();

      const router = new TaskRouter({
        clawteamApi: mockApi,
        sessionClient: mockSession,
        sessionTracker,
        gatewayUrl: 'http://localhost:3100',
        logger,
      });

      const poller = new TaskPollingLoop({
        clawteamApi: mockApi,
        router,
        pollIntervalMs: 60_000,
        pollLimit: 10,
        logger,
      });

      await poller.pollOnce();

      // Session tracker should record the assignment
      expect(sessionTracker.getSessionForTask(subTask.id)).toBe('agent:executor:sub:abc');
    });

    it('does not track session for tasks sent to main', async () => {
      const newTask = makeTask({ type: 'new' });

      const mockApi = createMockApi([newTask]);
      const mockSession = createMockSessionClient();
      const sessionTracker = new SessionTracker();

      const router = new TaskRouter({
        clawteamApi: mockApi,
        sessionClient: mockSession,
        sessionTracker,
        gatewayUrl: 'http://localhost:3100',
        logger,
      });

      const poller = new TaskPollingLoop({
        clawteamApi: mockApi,
        router,
        pollIntervalMs: 60_000,
        pollLimit: 10,
        logger,
      });

      await poller.pollOnce();

      // Main session tasks are not tracked in session tracker
      expect(sessionTracker.getSessionForTask(newTask.id)).toBeUndefined();
    });
  });

  describe('Message content verification', () => {
    it('new task message contains all required fields', async () => {
      const task = makeTask({
        type: 'new',
        capability: 'analyze_data',
        fromBotId: 'originator-123',
        parameters: { dataset: 'metrics-2026' },
      });

      const mockApi = createMockApi([task]);
      const mockSession = createMockSessionClient();

      const router = new TaskRouter({
        clawteamApi: mockApi,
        sessionClient: mockSession,
        sessionTracker: new SessionTracker(),
        gatewayUrl: 'http://localhost:3100',
        logger,
      });

      const poller = new TaskPollingLoop({
        clawteamApi: mockApi,
        router,
        pollIntervalMs: 60_000,
        pollLimit: 10,
        logger,
      });

      await poller.pollOnce();

      const message = mockSession.sentMessages[0].message;
      expect(message).toContain('[ClawTeam Task Received]');
      expect(message).toContain(`Task ID: ${task.id}`);
      expect(message).toContain('Capability: analyze_data');
      expect(message).toContain('From Bot: originator-123');
      expect(message).toContain('metrics-2026');
      // New task message includes CLAWTEAM token and spawn instruction
      expect(message).toContain('<!--CLAWTEAM:');
      expect(message).toContain('Spawn a sub-session now');
    });

    it('sub-task message references parent task', async () => {
      const task = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-xyz',
        capability: 'code_review',
        parameters: {
          targetSessionKey: 'agent:executor:sub:001',
          feedback: 'Check error handling',
        },
      });

      const mockApi = createMockApi([task]);
      const mockSession = createMockSessionClient();

      const router = new TaskRouter({
        clawteamApi: mockApi,
        sessionClient: mockSession,
        sessionTracker: new SessionTracker(),
        gatewayUrl: 'http://localhost:3100',
        logger,
      });

      const poller = new TaskPollingLoop({
        clawteamApi: mockApi,
        router,
        pollIntervalMs: 60_000,
        pollLimit: 10,
        logger,
      });

      await poller.pollOnce();

      const message = mockSession.sentMessages[0].message;
      expect(message).toContain('[ClawTeam sub-task Task]');
      expect(message).toContain(`Task ID: ${task.id}`);
      expect(message).toContain('Parent Task: parent-xyz');
      expect(message).toContain('Check error handling');
    });

    it('direct message prompt contains reply instructions', async () => {
      const mockApi = createMockApi([]);
      const dmMessage: InboxMessage = {
        messageId: 'dm-002',
        fromBotId: 'bot-alpha',
        toBotId: 'bot-beta',
        type: 'direct_message',
        contentType: 'text',
        content: 'Status update: deployment complete',
        priority: 'normal',
        traceId: 'trace-dm-002',
        timestamp: new Date().toISOString(),
      };
      mockApi.pollInbox.mockResolvedValueOnce([dmMessage]);

      const mockSession = createMockSessionClient();

      const router = new TaskRouter({
        clawteamApi: mockApi,
        sessionClient: mockSession,
        sessionTracker: new SessionTracker(),
        gatewayUrl: 'http://localhost:3100',
        logger,
      });

      const poller = new TaskPollingLoop({
        clawteamApi: mockApi,
        router,
        pollIntervalMs: 60_000,
        pollLimit: 10,
        logger,
      });

      await poller.pollOnce();

      const message = mockSession.sentMessages[0].message;
      expect(message).toContain('[ClawTeam Message Received]');
      expect(message).toContain('Message ID: dm-002');
      expect(message).toContain('From Bot: bot-alpha');
      expect(message).toContain('Status update: deployment complete');
      expect(message).toContain('/gateway/messages/send');
      expect(message).toContain('"toBotId":"bot-alpha"');
    });
  });

  describe('DM with taskId routing', () => {
    it('direct_message with taskId routes to correct sub-session', async () => {
      const mockApi = createMockApi([]);
      const mockSession = createMockSessionClient();
      const sessionTracker = new SessionTracker();

      // Simulate a task already being handled in a sub-session
      sessionTracker.track('task-active-001', 'agent:executor:sub:review');

      // API returns task details when queried
      const activeTask = makeTask({
        id: 'task-active-001',
        capability: 'code_review',
        fromBotId: 'bot-delegator',
        toBotId: 'bot-executor',
      });
      mockApi.getTask.mockImplementation(async (taskId: string) => {
        if (taskId === 'task-active-001') return activeTask;
        return null;
      });

      const dmMessage: InboxMessage = {
        messageId: 'dm-task-001',
        fromBotId: 'bot-delegator',
        toBotId: 'bot-executor',
        type: 'direct_message',
        contentType: 'text',
        content: 'Which branch should I review?',
        priority: 'normal',
        taskId: 'task-active-001',
        traceId: 'trace-dm-task-001',
        timestamp: new Date().toISOString(),
      };
      mockApi.pollInbox.mockResolvedValueOnce([dmMessage]);

      const router = new TaskRouter({
        clawteamApi: mockApi,
        sessionClient: mockSession,
        sessionTracker,
        gatewayUrl: 'http://localhost:3100',
        logger,
      });

      const poller = new TaskPollingLoop({
        clawteamApi: mockApi,
        router,
        pollIntervalMs: 60_000,
        pollLimit: 10,
        logger,
      });

      await poller.pollOnce();

      // Message should go to the sub-session, NOT main
      expect(mockSession.sendToMainSession).not.toHaveBeenCalled();
      expect(mockSession.sendToSession).toHaveBeenCalledTimes(1);
      expect(mockSession.sentMessages).toHaveLength(1);
      expect(mockSession.sentMessages[0].target).toBe('agent:executor:sub:review');

      const message = mockSession.sentMessages[0].message;
      expect(message).toContain('[ClawTeam Message -- Task Context]');
      expect(message).toContain('Task ID: task-active-001');
      expect(message).toContain('Capability: code_review');
      expect(message).toContain('From Bot: bot-delegator');
      expect(message).toContain('Which branch should I review?');
      // Reply template should pre-fill taskId
      expect(message).toContain('"taskId":"task-active-001"');
      expect(message).toContain('"toBotId":"bot-delegator"');
    });

    it('task delegation reply flow: delegate → DM with taskId → routes to sub-session', async () => {
      const mockSession = createMockSessionClient();
      const sessionTracker = new SessionTracker();

      // Phase 1: A new task arrives and gets routed to main (which spawns a sub-session)
      const delegatedTask = makeTask({
        type: 'new',
        capability: 'code_review',
        fromBotId: 'bot-lead',
        toBotId: 'bot-reviewer',
      });

      const mockApi = createMockApi([delegatedTask]);

      const router = new TaskRouter({
        clawteamApi: mockApi,
        sessionClient: mockSession,
        sessionTracker,
        gatewayUrl: 'http://localhost:3100',
        logger,
      });

      const poller = new TaskPollingLoop({
        clawteamApi: mockApi,
        router,
        pollIntervalMs: 60_000,
        pollLimit: 10,
        logger,
      });

      await poller.pollOnce();

      // Task routed to main
      expect(mockSession.sentMessages).toHaveLength(1);
      expect(mockSession.sentMessages[0].target).toBe('main');
      expect(mockSession.sentMessages[0].message).toContain('[ClawTeam Task Received]');
      // New task message includes CLAWTEAM token with task ID
      expect(mockSession.sentMessages[0].message).toContain('<!--CLAWTEAM:');
      expect(mockSession.sentMessages[0].message).toContain(`"taskId":"${delegatedTask.id}"`);

      // Phase 2: Simulate that main session spawned a sub-session and it accepted the task
      sessionTracker.track(delegatedTask.id, 'agent:reviewer:sub:work123');

      // Phase 3: The delegator (bot-lead) sends a DM with taskId to clarify
      const clarificationDm: InboxMessage = {
        messageId: 'dm-clarify-001',
        fromBotId: 'bot-lead',
        toBotId: 'bot-reviewer',
        type: 'direct_message',
        contentType: 'text',
        content: 'Focus on the error handling in src/api.ts',
        priority: 'high',
        taskId: delegatedTask.id,
        traceId: 'trace-clarify',
        timestamp: new Date().toISOString(),
      };
      mockApi.pollInbox.mockResolvedValueOnce([clarificationDm]);
      mockApi.getTask.mockResolvedValue(delegatedTask);

      // Clear previous sent messages
      mockSession.sentMessages.length = 0;

      await poller.pollOnce();

      // The DM should route to the sub-session handling the task
      expect(mockSession.sentMessages).toHaveLength(1);
      expect(mockSession.sentMessages[0].target).toBe('agent:reviewer:sub:work123');

      const dmPrompt = mockSession.sentMessages[0].message;
      expect(dmPrompt).toContain('[ClawTeam Message -- Task Context]');
      expect(dmPrompt).toContain(`Task ID: ${delegatedTask.id}`);
      expect(dmPrompt).toContain('Focus on the error handling in src/api.ts');
      expect(dmPrompt).toContain('Capability: code_review');
      // Reply template keeps the thread alive
      expect(dmPrompt).toContain(`"taskId":"${delegatedTask.id}"`);
      expect(dmPrompt).toContain('"toBotId":"bot-lead"');
    });

    it('direct_message with taskId falls back to main when task not tracked', async () => {
      const mockApi = createMockApi([]);
      const mockSession = createMockSessionClient();
      const sessionTracker = new SessionTracker();
      // No task tracked in any session

      mockApi.getTask.mockResolvedValue(
        makeTask({ id: 'task-untracked', capability: 'deploy', fromBotId: 'bot-ops' }),
      );

      const dmMessage: InboxMessage = {
        messageId: 'dm-untracked-001',
        fromBotId: 'bot-ops',
        toBotId: 'bot-deployer',
        type: 'direct_message',
        contentType: 'text',
        content: 'Deploy status?',
        priority: 'normal',
        taskId: 'task-untracked',
        traceId: 'trace-untracked',
        timestamp: new Date().toISOString(),
      };
      mockApi.pollInbox.mockResolvedValueOnce([dmMessage]);

      const router = new TaskRouter({
        clawteamApi: mockApi,
        sessionClient: mockSession,
        sessionTracker,
        gatewayUrl: 'http://localhost:3100',
        logger,
      });

      const poller = new TaskPollingLoop({
        clawteamApi: mockApi,
        router,
        pollIntervalMs: 60_000,
        pollLimit: 10,
        logger,
      });

      await poller.pollOnce();

      // Should go to main since task is not tracked
      expect(mockSession.sendToSession).not.toHaveBeenCalled();
      expect(mockSession.sendToMainSession).toHaveBeenCalledTimes(1);
      expect(mockSession.sentMessages).toHaveLength(1);
      expect(mockSession.sentMessages[0].target).toBe('main');

      const message = mockSession.sentMessages[0].message;
      expect(message).toContain('[ClawTeam Message -- Task Context]');
      expect(message).toContain('Task ID: task-untracked');
      expect(message).toContain('Deploy status?');
    });
  });
});
