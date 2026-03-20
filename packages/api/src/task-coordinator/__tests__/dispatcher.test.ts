/**
 * TaskDispatcher Tests
 */

import { TaskDispatcher } from '../dispatcher';
import { MockCapabilityRegistry } from '@clawteam/api/capability-registry';
import { MockMessageBus } from '@clawteam/api/message-bus';
import { InvalidTaskStateError, TaskNotFoundError, QueueFullError } from '../errors';
import { ValidationError } from '@clawteam/api/common';
import { MAX_QUEUE_SIZE, REDIS_KEYS } from '../constants';

// Mock database and redis
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
  const store = new Map<string, any>();
  const lists = new Map<string, string[]>();
  const hashes = new Map<string, Map<string, string>>();

  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => { store.set(key, value); }),
    del: jest.fn(async (key: string) => { store.delete(key); return 1; }),
    exists: jest.fn(async (key: string) => store.has(key) || hashes.has(key)),
    expire: jest.fn(async () => true),
    ttl: jest.fn(async () => -1),
    mget: jest.fn(),
    mset: jest.fn(),
    hget: jest.fn(async (key: string, field: string) => {
      const h = hashes.get(key);
      return h?.get(field) ?? null;
    }),
    hset: jest.fn(async (key: string, field: string, value: string) => {
      if (!hashes.has(key)) hashes.set(key, new Map());
      hashes.get(key)!.set(field, value);
      return 1;
    }),
    hgetall: jest.fn(async (key: string) => {
      const h = hashes.get(key);
      if (!h) return {};
      const obj: Record<string, string> = {};
      for (const [k, v] of h) obj[k] = v;
      return obj;
    }),
    hdel: jest.fn(async () => 1),
    lpush: jest.fn(async (key: string, ...values: string[]) => {
      if (!lists.has(key)) lists.set(key, []);
      lists.get(key)!.unshift(...values);
      return lists.get(key)!.length;
    }),
    rpush: jest.fn(async (key: string, ...values: string[]) => {
      if (!lists.has(key)) lists.set(key, []);
      lists.get(key)!.push(...values);
      return lists.get(key)!.length;
    }),
    lpop: jest.fn(async (key: string) => {
      const list = lists.get(key);
      return list?.shift() ?? null;
    }),
    rpop: jest.fn(),
    lrange: jest.fn(async (key: string, start: number, stop: number) => {
      const list = lists.get(key) || [];
      return list.slice(start, stop + 1);
    }),
    llen: jest.fn(async (key: string) => (lists.get(key) || []).length),
    lrem: jest.fn(async (key: string, _count: number, value: string) => {
      const list = lists.get(key);
      if (!list) return 0;
      const idx = list.indexOf(value);
      if (idx !== -1) { list.splice(idx, 1); return 1; }
      return 0;
    }),
    sadd: jest.fn(),
    srem: jest.fn(),
    smembers: jest.fn(async () => []),
    sismember: jest.fn(async () => false),
    zadd: jest.fn(),
    zrem: jest.fn(),
    zrangebyscore: jest.fn(async () => []),
    getClient: jest.fn(),
    duplicate: jest.fn(),
    close: jest.fn(),
    isConnected: jest.fn().mockReturnValue(true),
    // Store references for test assertions
    _lists: lists,
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

describe('TaskDispatcher', () => {
  let dispatcher: TaskDispatcher;
  let db: ReturnType<typeof createMockDb>;
  let redis: ReturnType<typeof createMockRedis>;
  let registry: MockCapabilityRegistry;
  let messageBus: MockMessageBus;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    db = createMockDb();
    redis = createMockRedis();
    registry = new MockCapabilityRegistry();
    messageBus = new MockMessageBus();
    logger = createMockLogger();

    dispatcher = new TaskDispatcher({
      db: db as any,
      redis: redis as any,
      registry,
      messageBus,
      logger: logger as any,
    });
  });

  describe('createTaskRecord', () => {
    it('should create a task record in DB', async () => {
      const task = await dispatcher.createTaskRecord(
        {
          prompt: 'test task',
          capability: 'test',
          parameters: { foo: 'bar' },
        },
        'from-bot'
      );

      expect(task.id).toBeDefined();
      expect(task.status).toBe('pending');
      expect(task.fromBotId).toBe('from-bot');
      expect(task.capability).toBe('test');
      expect(task.parameters).toEqual({ foo: 'bar' });

      // Should insert into database
      expect(db.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('delegate', () => {
    let targetBotId: string;

    beforeEach(async () => {
      // Register a target bot in the mock registry
      const result = await registry.register({
        name: 'target-bot',
        ownerEmail: 'test@test.com',
        capabilities: [
          {
            name: 'test',
            description: 'Test capability',
            async: false,
            estimatedTime: '5s',
          },
        ],
      });
      targetBotId = result.botId;
    });

    function setupDbForDelegate(taskId: string) {
      // SELECT returns a task row
      db.query.mockResolvedValueOnce({
        rows: [{
          id: taskId,
          from_bot_id: 'from-bot',
          to_bot_id: '',
          prompt: 'test task',
          capability: 'test',
          parameters: '{}',
          status: 'pending',
          priority: 'normal',
          type: 'new',
          timeout_seconds: 300,
          retry_count: 0,
          max_retries: 3,
          created_at: new Date(),
        }],
        rowCount: 1,
      });
      // UPDATE returns rowCount: 1
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // INSERT for messages DB
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    }

    it('should delegate a pre-created task and enqueue it', async () => {
      setupDbForDelegate('task-1');

      await dispatcher.delegate('task-1', targetBotId);

      // Should query DB for task + update to_bot_id + insert message
      expect(db.query).toHaveBeenCalled();

      // Should enqueue to Redis
      expect(redis.rpush).toHaveBeenCalled();
      expect(redis.hset).toHaveBeenCalled();

      // Should write task_notification to inbox
      expect(redis.lpush).toHaveBeenCalled();
    });

    it('should throw for non-existent target bot', async () => {
      await expect(
        dispatcher.delegate('task-1', 'non-existent')
      ).rejects.toThrow(TaskNotFoundError);
    });

    it('should throw ValidationError for missing toBotId', async () => {
      await expect(
        dispatcher.delegate('task-1', '')
      ).rejects.toThrow(ValidationError);
    });

    it('should throw TaskNotFoundError for non-existent task', async () => {
      // DB returns no rows for SELECT
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(
        dispatcher.delegate('non-existent', targetBotId)
      ).rejects.toThrow(TaskNotFoundError);
    });

    it('should throw QueueFullError when queue is full', async () => {
      // Simulate full queue
      const queueKey = `${REDIS_KEYS.TASK_QUEUE}:${targetBotId}:normal`;
      redis._lists.set(queueKey, new Array(MAX_QUEUE_SIZE).fill('task-id'));

      // DB returns a task row for SELECT
      db.query.mockResolvedValueOnce({
        rows: [{
          id: 'task-1',
          from_bot_id: 'from-bot',
          to_bot_id: '',
          prompt: 'test task',
          capability: 'test',
          parameters: '{}',
          status: 'pending',
          priority: 'normal',
          type: 'new',
          timeout_seconds: 300,
          retry_count: 0,
          max_retries: 3,
          created_at: new Date(),
        }],
        rowCount: 1,
      });

      await expect(
        dispatcher.delegate('task-1', targetBotId)
      ).rejects.toThrow(QueueFullError);
    });

    it('should throw InvalidTaskStateError when task is not pending', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{
          id: 'task-1',
          from_bot_id: 'from-bot',
          to_bot_id: '',
          prompt: 'test task',
          capability: 'test',
          parameters: '{}',
          status: 'processing',
          priority: 'normal',
          type: 'new',
          timeout_seconds: 300,
          retry_count: 0,
          max_retries: 3,
          created_at: new Date(),
        }],
        rowCount: 1,
      });

      await expect(
        dispatcher.delegate('task-1', targetBotId)
      ).rejects.toThrow(InvalidTaskStateError);
    });

    it('should log warning for offline bot but not reject', async () => {
      // Update bot status to offline
      await registry.updateStatus(targetBotId, 'offline');

      setupDbForDelegate('task-1');

      await dispatcher.delegate('task-1', targetBotId);

      expect(logger.warn).toHaveBeenCalled();
    });

    it('should not fail when message bus publish fails', async () => {
      // Close the message bus to simulate failure
      await messageBus.close();

      setupDbForDelegate('task-1');

      await dispatcher.delegate('task-1', targetBotId);
    });
  });

  describe('getQueueSize', () => {
    it('should return 0 for empty queues', async () => {
      const size = await dispatcher.getQueueSize('bot-1');
      expect(size).toBe(0);
    });

    it('should sum across all priority queues', async () => {
      redis._lists.set(`${REDIS_KEYS.TASK_QUEUE}:bot-1:urgent`, ['t1']);
      redis._lists.set(`${REDIS_KEYS.TASK_QUEUE}:bot-1:normal`, ['t2', 't3']);

      const size = await dispatcher.getQueueSize('bot-1');
      expect(size).toBe(3);
    });
  });
});
