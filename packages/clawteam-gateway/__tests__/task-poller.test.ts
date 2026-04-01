/**
 * Task Poller Tests (Unified Inbox)
 */

import type { Task } from '@clawteam/shared/types';
import type { IClawTeamApiClient } from '../src/clients/clawteam-api';
import type { InboxMessage, RoutingResult } from '../src/types';
import { TaskPollingLoop } from '../src/polling/task-poller';
import { TaskRouter } from '../src/routing/router';
import pino from 'pino';

function makeTask(id: string): Task {
  return {
    id,
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
  };
}

function makeInboxMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    messageId: 'msg-001',
    fromBotId: 'bot-a',
    toBotId: 'bot-b',
    type: 'task_notification',
    contentType: 'json',
    content: { taskId: 'task-1', capability: 'code_review' },
    priority: 'normal',
    taskId: 'task-1',
    traceId: 'trace-1',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const logger = pino({ level: 'silent' });

describe('TaskPollingLoop', () => {
  let poller: TaskPollingLoop;
  let mockApi: jest.Mocked<IClawTeamApiClient>;
  let mockRouter: { route: jest.Mock; routeMessage: jest.Mock };

  beforeEach(() => {
    mockApi = {
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

    mockRouter = {
      route: jest.fn().mockResolvedValue({
        taskId: 'task-001',
        success: true,
        action: 'send_to_main',
      } as RoutingResult),
      routeMessage: jest.fn().mockResolvedValue({
        taskId: 'msg-001',
        success: true,
        action: 'send_to_main',
      } as RoutingResult),
    };

    poller = new TaskPollingLoop({
      clawteamApi: mockApi,
      router: mockRouter as unknown as TaskRouter,
      pollIntervalMs: 60_000,
      pollLimit: 10,
      logger,
    });
  });

  afterEach(() => {
    poller.stop();
  });

  describe('pollOnce()', () => {
    it('polls the inbox API', async () => {
      await poller.pollOnce();
      expect(mockApi.pollInbox).toHaveBeenCalledWith(10);
    });

    it('routes task_notification messages via router.route()', async () => {
      const task = makeTask('task-1');
      const messages = [
        makeInboxMessage({ messageId: 'msg-1', taskId: 'task-1', content: { taskId: 'task-1' } }),
        makeInboxMessage({ messageId: 'msg-2', taskId: 'task-2', content: { taskId: 'task-2' } }),
      ];
      mockApi.pollInbox.mockResolvedValue(messages);
      mockApi.getTask
        .mockResolvedValueOnce(makeTask('task-1'))
        .mockResolvedValueOnce(makeTask('task-2'));

      await poller.pollOnce();

      expect(mockApi.getTask).toHaveBeenCalledTimes(2);
      expect(mockRouter.route).toHaveBeenCalledTimes(2);
    });

    it('routes direct_message messages via router.routeMessage()', async () => {
      const msg = makeInboxMessage({
        messageId: 'dm-1',
        type: 'direct_message',
        content: 'hello',
        taskId: undefined,
      });
      mockApi.pollInbox.mockResolvedValue([msg]);

      await poller.pollOnce();

      expect(mockRouter.routeMessage).toHaveBeenCalledTimes(1);
      expect(mockRouter.routeMessage).toHaveBeenCalledWith(msg);
      expect(mockRouter.route).not.toHaveBeenCalled();
    });

    it('does not route when no messages found', async () => {
      mockApi.pollInbox.mockResolvedValue([]);
      await poller.pollOnce();
      expect(mockRouter.route).not.toHaveBeenCalled();
      expect(mockRouter.routeMessage).not.toHaveBeenCalled();
    });

    it('handles API errors gracefully', async () => {
      mockApi.pollInbox.mockRejectedValue(new Error('Connection refused'));
      await poller.pollOnce();
      // Should not throw
    });

    it('skips task_notification when task not found', async () => {
      const msg = makeInboxMessage({ messageId: 'msg-1', taskId: 'missing-task', content: { taskId: 'missing-task' } });
      mockApi.pollInbox.mockResolvedValue([msg]);
      mockApi.getTask.mockResolvedValue(null);

      await poller.pollOnce();

      expect(mockRouter.route).not.toHaveBeenCalled();
    });

    it('handles routing errors for individual messages', async () => {
      const messages = [
        makeInboxMessage({ messageId: 'msg-1', taskId: 'task-1', content: { taskId: 'task-1' } }),
        makeInboxMessage({ messageId: 'msg-2', taskId: 'task-2', content: { taskId: 'task-2' } }),
      ];
      mockApi.pollInbox.mockResolvedValue(messages);
      mockApi.getTask
        .mockResolvedValueOnce(makeTask('task-1'))
        .mockResolvedValueOnce(makeTask('task-2'));
      mockRouter.route
        .mockResolvedValueOnce({ taskId: 'task-1', success: true, action: 'send_to_main' })
        .mockResolvedValueOnce({ taskId: 'task-2', success: false, action: 'send_to_main', error: 'Failed' });

      await poller.pollOnce();

      expect(mockRouter.route).toHaveBeenCalledTimes(2);
    });

    it('prevents overlapping polls', async () => {
      let resolveFirst: () => void;
      const slowPoll = new Promise<InboxMessage[]>((resolve) => {
        resolveFirst = () => resolve([]);
      });
      mockApi.pollInbox.mockReturnValueOnce(slowPoll);

      const firstPoll = poller.pollOnce();
      await poller.pollOnce();

      expect(mockApi.pollInbox).toHaveBeenCalledTimes(1);

      resolveFirst!();
      await firstPoll;
    });

    it('skips unsupported message types', async () => {
      const msg = makeInboxMessage({
        messageId: 'sys-1',
        type: 'system' as any,
        content: 'system event',
      });
      mockApi.pollInbox.mockResolvedValue([msg]);

      await poller.pollOnce();

      expect(mockRouter.route).not.toHaveBeenCalled();
      expect(mockRouter.routeMessage).not.toHaveBeenCalled();
    });
  });

  describe('ackMessage behavior', () => {
    it('calls ackMessage after successful task_notification routing', async () => {
      const msg = makeInboxMessage({ messageId: 'msg-ack-1', taskId: 'task-1', content: { taskId: 'task-1' } });
      mockApi.pollInbox.mockResolvedValue([msg]);
      mockApi.getTask.mockResolvedValue(makeTask('task-1'));
      mockRouter.route.mockResolvedValue({ taskId: 'task-1', success: true, action: 'send_to_main' });

      await poller.pollOnce();

      expect(mockApi.ackMessage).toHaveBeenCalledWith('msg-ack-1');
    });

    it('calls ackMessage after successful direct_message routing', async () => {
      const msg = makeInboxMessage({
        messageId: 'dm-ack-1',
        type: 'direct_message',
        content: 'hello',
        taskId: undefined,
      });
      mockApi.pollInbox.mockResolvedValue([msg]);
      mockRouter.routeMessage.mockResolvedValue({ taskId: 'dm-ack-1', success: true, action: 'send_to_main' });

      await poller.pollOnce();

      expect(mockApi.ackMessage).toHaveBeenCalledWith('dm-ack-1');
    });

    it('does not call ackMessage when task_notification routing fails', async () => {
      const msg = makeInboxMessage({ messageId: 'msg-fail-1', taskId: 'task-1', content: { taskId: 'task-1' } });
      mockApi.pollInbox.mockResolvedValue([msg]);
      mockApi.getTask.mockResolvedValue(makeTask('task-1'));
      mockRouter.route.mockResolvedValue({ taskId: 'task-1', success: false, action: 'send_to_main', error: 'delivery_failed' });

      await poller.pollOnce();

      expect(mockApi.ackMessage).not.toHaveBeenCalled();
    });

    it('does not call ackMessage when direct_message routing fails', async () => {
      const msg = makeInboxMessage({
        messageId: 'dm-fail-1',
        type: 'direct_message',
        content: 'hello',
        taskId: undefined,
      });
      mockApi.pollInbox.mockResolvedValue([msg]);
      mockRouter.routeMessage.mockResolvedValue({ taskId: 'dm-fail-1', success: false, action: 'send_to_main', error: 'delivery_failed' });

      await poller.pollOnce();

      expect(mockApi.ackMessage).not.toHaveBeenCalled();
    });

    it('does not call ackMessage on session_busy and counts as skipped', async () => {
      const msg = makeInboxMessage({ messageId: 'msg-busy-1', taskId: 'task-1', content: { taskId: 'task-1' } });
      mockApi.pollInbox.mockResolvedValue([msg]);
      mockApi.getTask.mockResolvedValue(makeTask('task-1'));
      mockRouter.route.mockResolvedValue({ taskId: 'task-1', success: false, action: 'send_to_main', error: 'session_busy' });

      const pollComplete = new Promise<any>((resolve) => {
        poller.on('poll_complete', resolve);
      });

      await poller.pollOnce();
      const stats = await pollComplete;

      expect(mockApi.ackMessage).not.toHaveBeenCalled();
      expect(stats.skipped).toBe(1);
    });

    it('continues normally when ackMessage throws', async () => {
      const msg = makeInboxMessage({ messageId: 'msg-ack-err', taskId: 'task-1', content: { taskId: 'task-1' } });
      mockApi.pollInbox.mockResolvedValue([msg]);
      mockApi.getTask.mockResolvedValue(makeTask('task-1'));
      mockRouter.route.mockResolvedValue({ taskId: 'task-1', success: true, action: 'send_to_main' });
      mockApi.ackMessage.mockRejectedValue(new Error('ACK network error'));

      // Should not throw
      await poller.pollOnce();

      expect(mockApi.ackMessage).toHaveBeenCalledWith('msg-ack-err');
    });
  });

  describe('start() / stop()', () => {
    it('starts and stops without error', () => {
      poller.start();
      poller.stop();
    });

    it('stop is idempotent', () => {
      poller.start();
      poller.stop();
      poller.stop();
    });
  });
});
