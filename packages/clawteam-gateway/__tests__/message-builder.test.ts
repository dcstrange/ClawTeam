/**
 * Message Builder Tests — Baseline for Provider Abstraction
 *
 * Verifies the content of messages built by router.ts (4 methods) and
 * stale-task-recovery-loop.ts (2 methods). These tests capture the exact
 * message content (CLAWTEAM tokens, spawn instructions, curl URLs, etc.)
 * so that after Commit 3 extracts them into OpenClawMessageBuilder, we
 * have regression coverage for message correctness.
 *
 * Strategy: call the public API (router.route / loop.tick), then inspect
 * the actual message strings from mock sendToMainSession / sendToSession
 * calls. No bracket-access to private methods.
 */

import type { Task } from '@clawteam/shared/types';
import type { IClawTeamApiClient } from '../src/clients/clawteam-api';
import type { ISessionClient } from '../src/providers/types';
import type { TaskSessionStatus, SessionState } from '../src/monitoring/types';
import { TaskRouter } from '../src/routing/router';
import { StaleTaskRecoveryLoop } from '../src/recovery/stale-task-recovery-loop';
import { SessionTracker } from '../src/routing/session-tracker';
import { RoutedTasksTracker } from '../src/routing/routed-tasks';
import { SessionStatusResolver } from '../src/monitoring/session-status-resolver';
import { OpenClawMessageBuilder } from '../src/providers/openclaw/openclaw-message-builder';
import pino from 'pino';

// ── Helpers ────────────────────────────────────────────────────

const logger = pino({ level: 'silent' });
const GATEWAY_URL = 'http://localhost:3100';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-001',
    fromBotId: 'bot-sender',
    toBotId: 'bot-executor',
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

function createMockSession(): jest.Mocked<Required<ISessionClient>> {
  return {
    sendToSession: jest.fn().mockResolvedValue(true),
    sendToMainSession: jest.fn().mockResolvedValue(true),
    isSessionAlive: jest.fn().mockResolvedValue(true),
    restoreSession: jest.fn().mockResolvedValue(false),
    resolveSessionKeyFromId: jest.fn().mockReturnValue(undefined),
    resetMainSession: jest.fn().mockResolvedValue(null),
  };
}

function createMockResolver(): jest.Mocked<Pick<SessionStatusResolver, 'resolveForTasks' | 'fetchCliSessions'>> {
  return {
    resolveForTasks: jest.fn().mockResolvedValue([]),
    fetchCliSessions: jest.fn().mockResolvedValue([]),
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

// ── Router Message Builder Tests ───────────────────────────────

describe('Router message content verification', () => {
  let router: TaskRouter;
  let mockApi: jest.Mocked<IClawTeamApiClient>;
  let mockSession: jest.Mocked<Required<ISessionClient>>;
  let sessionTracker: SessionTracker;

  beforeEach(() => {
    mockApi = createMockApi();
    mockSession = createMockSession();
    sessionTracker = new SessionTracker();
    router = new TaskRouter({
      clawteamApi: mockApi,
      sessionClient: mockSession,
      sessionTracker,
      messageBuilder: new OpenClawMessageBuilder(GATEWAY_URL),
      gatewayUrl: GATEWAY_URL,
      logger,
    });
  });

  describe('buildNewTaskMessage (via route() for type=new)', () => {
    it('includes CLAWTEAM metadata token with correct role and taskId', async () => {
      const task = makeTask({ type: 'new', id: 'task-new-001' });
      await router.route(task);

      const msg = mockSession.sendToMainSession.mock.calls[0][0];
      expect(msg).toContain('<!--CLAWTEAM:');
      expect(msg).toContain('"role":"executor"');
      expect(msg).toContain('"taskId":"task-new-001"');
      expect(msg).toContain('"fromBotId":"bot-sender"');
    });

    it('includes spawn instruction and no-follow-up directive', async () => {
      const task = makeTask({ type: 'new' });
      await router.route(task);

      const msg = mockSession.sendToMainSession.mock.calls[0][0];
      expect(msg).toContain('ACTION REQUIRED: Spawn a sub-session now.');
      expect(msg).toContain('No follow-up sessions_send is needed');
    });

    it('includes task metadata header', async () => {
      const task = makeTask({
        type: 'new',
        id: 'task-meta-001',
        capability: 'deploy',
        priority: 'high',
      });
      await router.route(task);

      const msg = mockSession.sendToMainSession.mock.calls[0][0];
      expect(msg).toContain('[ClawTeam Task Received]');
      expect(msg).toContain('Task ID: task-meta-001');
      expect(msg).toContain('Capability: deploy');
      expect(msg).toContain('Priority: high');
    });

    it('includes fromBot name when API returns bot info', async () => {
      mockApi.getBot.mockResolvedValue({ id: 'bot-sender', name: 'TestBot' } as any);
      const task = makeTask({ type: 'new' });
      await router.route(task);

      const msg = mockSession.sendToMainSession.mock.calls[0][0];
      expect(msg).toContain('From Bot: TestBot (bot-sender)');
    });

    it('includes task value between START/END markers', async () => {
      const task = makeTask({ type: 'new' });
      await router.route(task);

      const msg = mockSession.sendToMainSession.mock.calls[0][0];
      expect(msg).toContain('---TASK VALUE START---');
      expect(msg).toContain('---TASK VALUE END---');
    });

    it('cleans delegation prefix from prompt', async () => {
      const task = makeTask({
        type: 'new',
        prompt: 'Delegate a task to bot abc123: \nPrompt: Write a test',
      });
      await router.route(task);

      const msg = mockSession.sendToMainSession.mock.calls[0][0];
      // The cleaned prompt should remove the delegation prefix
      expect(msg).toContain('Write a test');
    });

    it('includes parameters when present', async () => {
      const task = makeTask({
        type: 'new',
        parameters: { repo: 'my-repo', branch: 'main' },
      });
      await router.route(task);

      const msg = mockSession.sendToMainSession.mock.calls[0][0];
      expect(msg).toContain('my-repo');
      expect(msg).toContain('main');
    });
  });

  describe('buildSubTaskMessage (via route() for type=sub-task)', () => {
    it('sends directly to target session with task details', async () => {
      const task = makeTask({
        type: 'sub-task',
        id: 'task-sub-001',
        parentTaskId: 'parent-001',
        capability: 'code_review',
        prompt: 'Review error handling',
        parameters: { targetSessionKey: 'agent:bot:sub:abc' },
      });
      await router.route(task);

      const msg = mockSession.sendToSession.mock.calls[0][1];
      expect(msg).toContain('[ClawTeam sub-task Task]');
      expect(msg).toContain('Task ID: task-sub-001');
      expect(msg).toContain('Prompt: Review error handling');
      expect(msg).toContain('Capability: code_review');
      expect(msg).toContain('Parent Task: parent-001');
      expect(msg).toContain('auto-accepted by the gateway');
    });
  });

  describe('buildDelegateIntentMessage (via routeDelegateIntent)', () => {
    it('includes CLAWTEAM token with sender role', async () => {
      const message = {
        messageId: 'msg-delegate-001',
        fromBotId: 'bot-delegator',
        toBotId: 'bot-executor',
        type: 'delegate_intent' as const,
        contentType: 'json' as const,
        content: {
          prompt: 'Delegate a task to bot target-bot: Deploy to staging',
          toBotId: 'target-bot',
        },
        priority: 'normal' as const,
        traceId: 'trace-d',
        timestamp: new Date().toISOString(),
      };
      await router.routeDelegateIntent(message);

      const msg = mockSession.sendToMainSession.mock.calls[0][0];
      expect(msg).toContain('<!--CLAWTEAM:');
      expect(msg).toContain('"role":"sender"');
      expect(msg).toContain('[ClawTeam Delegate Intent]');
      expect(msg).toContain('ACTION REQUIRED: Spawn a sub-session now.');
      expect(msg).toContain('No follow-up sessions_send is needed');
    });
  });

  describe('buildFallbackMessage (via route() for expired sub-task session)', () => {
    it('includes parent task context when available', async () => {
      mockSession.isSessionAlive.mockResolvedValue(false);
      mockApi.getTask.mockResolvedValue(
        makeTask({ id: 'parent-001', status: 'completed', result: { summary: 'done' } }),
      );

      const task = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        parameters: { targetSessionKey: 'session-dead' },
      });
      await router.route(task);

      const msg = mockSession.sendToMainSession.mock.calls[0][0];
      expect(msg).toContain('[ClawTeam Task Received]');
      expect(msg).toContain('Parent Task Context');
      expect(msg).toContain('Parent Task ID: parent-001');
      expect(msg).toContain('Parent Status: completed');
    });

    it('includes spawn instruction for fallback to main', async () => {
      mockSession.isSessionAlive.mockResolvedValue(false);

      const task = makeTask({
        type: 'sub-task',
        parentTaskId: 'parent-001',
        parameters: { targetSessionKey: 'session-dead' },
      });
      await router.route(task);

      const msg = mockSession.sendToMainSession.mock.calls[0][0];
      expect(msg).toContain('Spawn a sub-session with this task value');
      expect(msg).toContain('No follow-up sessions_send is needed');
    });
  });
});

// ── Recovery Loop Message Builder Tests ────────────────────────

describe('Recovery loop message content verification', () => {
  let loop: StaleTaskRecoveryLoop;
  let mockApi: jest.Mocked<IClawTeamApiClient>;
  let mockResolver: jest.Mocked<Pick<SessionStatusResolver, 'resolveForTasks' | 'fetchCliSessions'>>;
  let mockSession: jest.Mocked<Required<ISessionClient>>;
  let tracker: SessionTracker;
  let routedTasks: RoutedTasksTracker;

  const STALE_TIME = new Date(Date.now() - 6 * 60 * 1000);

  beforeEach(() => {
    jest.useFakeTimers();
    mockApi = createMockApi();
    mockResolver = createMockResolver();
    mockSession = createMockSession();
    tracker = new SessionTracker();
    routedTasks = new RoutedTasksTracker();

    loop = new StaleTaskRecoveryLoop({
      resolver: mockResolver as any,
      clawteamApi: mockApi,
      sessionClient: mockSession,
      sessionTracker: tracker,
      messageBuilder: new OpenClawMessageBuilder(GATEWAY_URL),
      routedTasks,
      intervalMs: 120_000,
      stalenessThresholdMs: 300_000,
      maxRecoveryAttempts: 3,
      gatewayUrl: GATEWAY_URL,
      mainSessionKey: 'agent:main:main',
      logger,
    });
  });

  afterEach(() => {
    loop.stop();
    jest.useRealTimers();
  });

  describe('buildNudgeMessage (via tick() for idle session)', () => {
    it('includes task details and recovery attempt info', async () => {
      tracker.track('task-nudge', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-nudge', 'agent:main:subagent:abc', 'idle', STALE_TIME),
      ]);
      mockApi.getTask.mockResolvedValue(makeTask({
        id: 'task-nudge',
        capability: 'deploy',
        prompt: 'Deploy to production',
        status: 'processing',
      }));

      await loop.tick();

      const msg = mockSession.sendToSession.mock.calls[0][1];
      expect(msg).toContain('[ClawTeam Task Recovery — Nudge]');
      expect(msg).toContain('Task ID: task-nudge');
      expect(msg).toContain('Instructions: Deploy to production');
      expect(msg).toContain('Capability: deploy');
      expect(msg).toContain('Recovery Attempt: 1/3');
      expect(msg).toContain('Session State Detected: idle');
    });

    it('includes gatewayUrl-based completion and need-human-input URLs', async () => {
      tracker.track('task-nudge-url', 'agent:main:subagent:abc');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-nudge-url', 'agent:main:subagent:abc', 'idle', STALE_TIME),
      ]);
      mockApi.getTask.mockResolvedValue(makeTask({
        id: 'task-nudge-url',
        status: 'processing',
      }));

      await loop.tick();

      const msg = mockSession.sendToSession.mock.calls[0][1];
      expect(msg).toContain(`POST ${GATEWAY_URL}/gateway/tasks/task-nudge-url/complete`);
      expect(msg).toContain(`POST ${GATEWAY_URL}/gateway/tasks/task-nudge-url/need-human-input`);
    });
  });

  describe('buildRecoveryFallbackMessage (via tick() for dead session)', () => {
    it('uses standard task format with sub-session spawn instructions', async () => {
      tracker.track('task-fallback', 'agent:main:subagent:dead');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-fallback', 'agent:main:subagent:dead', 'dead'),
      ]);
      mockSession.restoreSession.mockResolvedValue(false);
      mockApi.resetTask.mockResolvedValue(false);
      mockApi.getTask.mockResolvedValue(makeTask({
        id: 'task-fallback',
        capability: 'code_review',
        status: 'processing',
        fromBotId: 'bot-originator',
        priority: 'high',
        type: 'new',
        parameters: { repo: 'my-repo' },
      }));

      await loop.tick();

      const msg = mockSession.sendToMainSession.mock.calls[0][0];
      expect(msg).toContain('[ClawTeam Task Received]');
      expect(msg).toContain('Task ID: task-fallback');
      expect(msg).toContain('From Bot: bot-originator');
      expect(msg).toContain('Priority: high');
      expect(msg).toContain('SUB-SESSION TASK DETAILS');
      expect(msg).toContain('DO NOT call any /tasks/ API endpoints yourself');
    });

    it('includes gatewayUrl-based curl commands for task operations', async () => {
      tracker.track('task-fb-url', 'agent:main:subagent:dead');

      mockResolver.resolveForTasks.mockResolvedValue([
        makeStatus('task-fb-url', 'agent:main:subagent:dead', 'dead'),
      ]);
      mockSession.restoreSession.mockResolvedValue(false);
      mockApi.resetTask.mockResolvedValue(false);
      mockApi.getTask.mockResolvedValue(makeTask({
        id: 'task-fb-url',
        status: 'processing',
        fromBotId: 'bot-sender',
      }));

      await loop.tick();

      const msg = mockSession.sendToMainSession.mock.calls[0][0];
      expect(msg).toContain(`${GATEWAY_URL}/gateway/track-session`);
      expect(msg).toContain(`${GATEWAY_URL}/gateway/tasks/task-fb-url/complete`);
      expect(msg).toContain(`${GATEWAY_URL}/gateway/tasks/task-fb-url/need-human-input`);
      expect(msg).toContain(`${GATEWAY_URL}/gateway/messages/send`);
    });
  });
});
