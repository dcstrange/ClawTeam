/**
 * TaskCompleter Tests
 */

import { TaskCompleter } from '../completer';
import { MockMessageBus } from '@clawteam/api/message-bus';
import {
  TaskNotFoundError,
  TaskAlreadyAcceptedError,
  UnauthorizedTaskError,
  InvalidTaskStateError,
} from '../errors';
import { REDIS_KEYS } from '../constants';

function createMockDb() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    getClient: jest.fn(),
    transaction: jest.fn(),
    close: jest.fn(),
    isConnected: jest.fn().mockReturnValue(true),
  };
}

function createMockRedis() {
  const hashes = new Map<string, Map<string, string>>();

  return {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(async () => 1),
    exists: jest.fn(async (key: string) => hashes.has(key)),
    expire: jest.fn(async () => true),
    ttl: jest.fn(),
    mget: jest.fn(),
    mset: jest.fn(),
    hget: jest.fn(async (key: string, field: string) => hashes.get(key)?.get(field) ?? null),
    hset: jest.fn(async (key: string, field: string, value: string) => {
      if (!hashes.has(key)) hashes.set(key, new Map());
      hashes.get(key)!.set(field, value);
      return 1;
    }),
    hgetall: jest.fn(),
    hdel: jest.fn(),
    lpush: jest.fn(),
    rpush: jest.fn(),
    lpop: jest.fn(),
    rpop: jest.fn(),
    lrange: jest.fn(async () => []),
    llen: jest.fn(async () => 0),
    lrem: jest.fn(async () => 0),
    sadd: jest.fn(),
    srem: jest.fn(),
    smembers: jest.fn(async () => []),
    sismember: jest.fn(async () => false),
    zadd: jest.fn(async () => 1),
    zrem: jest.fn(async () => 1),
    zrangebyscore: jest.fn(async () => []),
    getClient: jest.fn(),
    duplicate: jest.fn(),
    close: jest.fn(),
    isConnected: jest.fn().mockReturnValue(true),
    _hashes: hashes,
  };
}

function createMockLogger() {
  return {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
  };
}

function createTaskRow(overrides: Record<string, any> = {}) {
  const now = new Date();
  return {
    id: 'task-1',
    from_bot_id: 'bot-a',
    to_bot_id: 'bot-b',
    capability: 'test',
    parameters: {},
    status: 'pending',
    priority: 'normal',
    result: null,
    error: null,
    timeout_seconds: 300,
    retry_count: 0,
    max_retries: 3,
    created_at: now,
    accepted_at: null,
    started_at: null,
    completed_at: null,
    human_context: null,
    conversation_id: null,
    workflow_id: null,
    metadata: null,
    ...overrides,
  };
}

describe('TaskCompleter', () => {
  let completer: TaskCompleter;
  let db: ReturnType<typeof createMockDb>;
  let redis: ReturnType<typeof createMockRedis>;
  let messageBus: MockMessageBus;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    db = createMockDb();
    redis = createMockRedis();
    messageBus = new MockMessageBus();
    logger = createMockLogger();

    completer = new TaskCompleter({
      db: db as any,
      redis: redis as any,
      messageBus,
      logger: logger as any,
    });
  });

  // ===== accept =====

  describe('accept', () => {
    it('should accept a pending task', async () => {
      db.query.mockResolvedValueOnce({
        rows: [createTaskRow()],
        rowCount: 1,
      });
      // UPDATE returns rowCount: 1 to indicate success
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await completer.accept('task-1', 'bot-b');

      // Should update status in DB
      expect(db.query).toHaveBeenCalledTimes(2);
      const updateCall = db.query.mock.calls[1];
      expect(updateCall[0]).toContain("status = 'processing'");

      // Should remove from queue
      expect(redis.lrem).toHaveBeenCalled();

      // Should add to processing ZSET
      expect(redis.zadd).toHaveBeenCalledWith(
        REDIS_KEYS.PROCESSING_SET,
        expect.any(String),
        'task-1'
      );

      // Should publish notification
      const messages = messageBus.getPublishedMessages();
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it('should throw TaskNotFoundError for missing task', async () => {
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(
        completer.accept('non-existent', 'bot-b')
      ).rejects.toThrow(TaskNotFoundError);
    });

    it('should throw UnauthorizedTaskError for wrong bot', async () => {
      db.query.mockResolvedValueOnce({
        rows: [createTaskRow()],
        rowCount: 1,
      });

      await expect(
        completer.accept('task-1', 'bot-c')
      ).rejects.toThrow(UnauthorizedTaskError);
    });

    it('should throw TaskAlreadyAcceptedError if not pending', async () => {
      db.query.mockResolvedValueOnce({
        rows: [createTaskRow({ status: 'accepted' })],
        rowCount: 1,
      });

      await expect(
        completer.accept('task-1', 'bot-b')
      ).rejects.toThrow(TaskAlreadyAcceptedError);
    });
  });

  // ===== complete =====

  describe('complete', () => {
    it('should complete a task with result', async () => {
      db.query.mockResolvedValueOnce({
        rows: [createTaskRow({ status: 'processing' })],
        rowCount: 1,
      });
      // UPDATE returns rowCount: 1
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await completer.complete(
        'task-1',
        { status: 'completed', result: { count: 42 } },
        'bot-b'
      );

      const updateCall = db.query.mock.calls[1];
      expect(updateCall[1]).toContain('completed');
      expect(updateCall[1][1]).toContain('"count":42');

      // Should remove from processing set
      expect(redis.zrem).toHaveBeenCalledWith(REDIS_KEYS.PROCESSING_SET, 'task-1');

      // Should delete cache
      expect(redis.del).toHaveBeenCalled();

      // Should publish task_completed
      const messages = messageBus.getPublishedMessages();
      expect(messages.some(m => m.event === 'task_completed')).toBe(true);
    });

    it('should complete a task as failed', async () => {
      db.query.mockResolvedValueOnce({
        rows: [createTaskRow({ status: 'accepted' })],
        rowCount: 1,
      });
      // UPDATE returns rowCount: 1
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await completer.complete(
        'task-1',
        { status: 'failed', error: { code: 'ERR', message: 'oops' } },
        'bot-b'
      );

      const updateCall = db.query.mock.calls[1];
      expect(updateCall[1][0]).toBe('failed');

      const messages = messageBus.getPublishedMessages();
      expect(messages.some(m => m.event === 'task_failed')).toBe(true);
    });

    it('should throw InvalidTaskStateError for pending task', async () => {
      db.query.mockResolvedValueOnce({
        rows: [createTaskRow({ status: 'pending' })],
        rowCount: 1,
      });

      await expect(
        completer.complete('task-1', { status: 'completed' }, 'bot-b')
      ).rejects.toThrow(InvalidTaskStateError);
    });
  });

  // ===== cancel =====

  // ===== submit-result =====

  describe('submitResult', () => {
    it('should move task to pending_review and notify delegator inbox', async () => {
      db.query
        .mockResolvedValueOnce({
          rows: [createTaskRow({ status: 'processing' })],
          rowCount: 1,
        })
        // UPDATE tasks ... status = pending_review
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        // INSERT messages (direct_message to delegator inbox)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const finalResult = { summary: 'done' };
      await completer.submitResult('task-1', finalResult, 'bot-b');

      // Should enqueue a direct_message to delegator (to bot-a in fixture)
      expect(redis.lpush).toHaveBeenCalledWith(
        'clawteam:inbox:bot-a:high',
        expect.any(String),
      );

      const payload = (redis.lpush as jest.Mock).mock.calls[0][1];
      const inboxMsg = JSON.parse(payload);
      expect(inboxMsg.type).toBe('direct_message');
      expect(inboxMsg.taskId).toBe('task-1');
      expect(inboxMsg.fromBotId).toBe('bot-b');
      expect(inboxMsg.toBotId).toBe('bot-a');
      expect(inboxMsg.content?.submittedResult).toEqual(finalResult);

      // Should still publish event bus notification for dashboard/ws consumers
      const messages = messageBus.getPublishedMessages();
      expect(messages.some(m => m.event === 'task_pending_review')).toBe(true);
    });
  });

  describe('cancel', () => {
    it('should cancel a pending task by the sender', async () => {
      db.query.mockResolvedValueOnce({
        rows: [createTaskRow()],
        rowCount: 1,
      });
      // UPDATE returns rowCount: 1
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await completer.cancel('task-1', 'No longer needed', 'bot-a');

      const updateCall = db.query.mock.calls[1];
      expect(updateCall[0]).toContain("status = 'cancelled'");

      // Should clean up Redis
      expect(redis.lrem).toHaveBeenCalled();
      expect(redis.zrem).toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalled();

      // Should notify target bot
      const messages = messageBus.getPublishedMessages();
      expect(messages.some(m => m.event === 'task_failed')).toBe(true);
    });

    it('should throw UnauthorizedTaskError if not the sender', async () => {
      db.query.mockResolvedValueOnce({
        rows: [createTaskRow()],
        rowCount: 1,
      });

      await expect(
        completer.cancel('task-1', 'reason', 'bot-b')
      ).rejects.toThrow(UnauthorizedTaskError);
    });

    it('should throw InvalidTaskStateError for processing task', async () => {
      db.query.mockResolvedValueOnce({
        rows: [createTaskRow({ status: 'processing' })],
        rowCount: 1,
      });

      await expect(
        completer.cancel('task-1', 'reason', 'bot-a')
      ).rejects.toThrow(InvalidTaskStateError);
    });
  });

  describe('resume', () => {
    it('should write human input message as caller bot (not fixed delegator bot)', async () => {
      db.query
        .mockResolvedValueOnce({
          rows: [createTaskRow({
            status: 'waiting_for_input',
            result: {
              waitingRequests: [{ botId: 'bot-b', reason: 'Need details' }],
              waitingRequestedBy: 'bot-b',
              waitingReason: 'Need details',
            },
          })],
          rowCount: 1,
        })
        // UPDATE tasks ... status=processing
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        // INSERT human_input_response event
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        // INSERT direct_message into messages
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await completer.resume('task-1', 'bot-b', 'Please use Gemini CLI');

      expect(redis.lpush).toHaveBeenCalledWith(
        'clawteam:inbox:bot-b:high',
        expect.any(String),
      );

      const payload = (redis.lpush as jest.Mock).mock.calls[0][1];
      const inboxMsg = JSON.parse(payload);
      expect(inboxMsg.type).toBe('direct_message');
      expect(inboxMsg.taskId).toBe('task-1');
      expect(inboxMsg.fromBotId).toBe('bot-b');
      expect(inboxMsg.toBotId).toBe('bot-b');
      expect(inboxMsg.content?.text).toContain('Please use Gemini CLI');

      const insertDirectMessageCall = (db.query as jest.Mock).mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes("INSERT INTO messages") && call[0].includes("'direct_message'"),
      );
      expect(insertDirectMessageCall).toBeTruthy();
      expect(insertDirectMessageCall?.[1]?.[1]).toBe('bot-b'); // from_bot_id
      expect(insertDirectMessageCall?.[1]?.[2]).toBe('bot-b'); // to_bot_id
    });
  });

  // ===== reset =====

  describe('reset', () => {
    it('should reset an accepted task back to pending', async () => {
      db.query.mockResolvedValueOnce({
        rows: [createTaskRow({ status: 'accepted' })],
        rowCount: 1,
      });
      // UPDATE returns rowCount: 1
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await completer.reset('task-1', 'bot-b');

      const updateCall = db.query.mock.calls[1];
      expect(updateCall[0]).toContain("status = 'pending'");
      expect(updateCall[0]).toContain('executor_session_key = NULL');
      expect(updateCall[0]).toContain('retry_count = retry_count + 1');

      // Should re-enqueue in priority queue
      expect(redis.lpush).toHaveBeenCalled();

      // Should remove from processing ZSET
      expect(redis.zrem).toHaveBeenCalledWith(REDIS_KEYS.PROCESSING_SET, 'task-1');

      // Should clear cache
      expect(redis.del).toHaveBeenCalled();
    });

    it('should reset a processing task back to pending', async () => {
      db.query.mockResolvedValueOnce({
        rows: [createTaskRow({ status: 'processing' })],
        rowCount: 1,
      });
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await completer.reset('task-1', 'bot-b');

      const updateCall = db.query.mock.calls[1];
      expect(updateCall[0]).toContain("status = 'pending'");
    });

    it('should throw TaskNotFoundError for missing task', async () => {
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(
        completer.reset('non-existent', 'bot-b')
      ).rejects.toThrow(TaskNotFoundError);
    });

    it('should throw UnauthorizedTaskError for wrong bot', async () => {
      db.query.mockResolvedValueOnce({
        rows: [createTaskRow({ status: 'accepted' })],
        rowCount: 1,
      });

      await expect(
        completer.reset('task-1', 'bot-c')
      ).rejects.toThrow(UnauthorizedTaskError);
    });

    it('should throw InvalidTaskStateError for pending task', async () => {
      db.query.mockResolvedValueOnce({
        rows: [createTaskRow({ status: 'pending' })],
        rowCount: 1,
      });

      await expect(
        completer.reset('task-1', 'bot-b')
      ).rejects.toThrow(InvalidTaskStateError);
    });

    it('should throw InvalidTaskStateError for completed task', async () => {
      db.query.mockResolvedValueOnce({
        rows: [createTaskRow({ status: 'completed' })],
        rowCount: 1,
      });

      await expect(
        completer.reset('task-1', 'bot-b')
      ).rejects.toThrow(InvalidTaskStateError);
    });

    it('should throw error when retries exhausted', async () => {
      db.query.mockResolvedValueOnce({
        rows: [createTaskRow({ status: 'processing', retry_count: 3, max_retries: 3 })],
        rowCount: 1,
      });

      await expect(
        completer.reset('task-1', 'bot-b')
      ).rejects.toThrow('exhausted retries');
    });

    it('should handle concurrent state change (UPDATE rowCount 0)', async () => {
      db.query.mockResolvedValueOnce({
        rows: [createTaskRow({ status: 'accepted' })],
        rowCount: 1,
      });
      // Concurrent cancellation makes UPDATE match 0 rows
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(
        completer.reset('task-1', 'bot-b')
      ).rejects.toThrow(InvalidTaskStateError);
    });
  });
});
