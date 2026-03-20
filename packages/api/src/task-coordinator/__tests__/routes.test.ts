/**
 * Routes Tests - Using MockTaskCoordinator
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { createTaskRoutes } from '../routes';
import { MockTaskCoordinator } from '../mocks';

// Helper: createTask + delegate in one step
async function createAndDelegate(
  coordinator: MockTaskCoordinator,
  req: { toBotId: string; prompt: string; capability?: string; parameters: any },
  fromBotId: string
) {
  const task = await coordinator.createTask(
    { prompt: req.prompt, capability: req.capability, parameters: req.parameters },
    fromBotId
  );
  await coordinator.delegate(task.id, req.toBotId);
  return task;
}

describe('Task Coordinator Routes', () => {
  let app: FastifyInstance;
  let coordinator: MockTaskCoordinator;

  beforeEach(async () => {
    coordinator = new MockTaskCoordinator();
    app = Fastify();
    await app.register(createTaskRoutes({ coordinator }), { prefix: '/api/v1/tasks' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // ===== POST /create + POST /:taskId/delegate =====

  describe('POST /api/v1/tasks/create + POST /api/v1/tasks/:taskId/delegate', () => {
    it('should create a task and delegate it', async () => {
      // Step 1: Create task
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/tasks/create',
        headers: { 'x-bot-id': 'bot-a' },
        payload: {
          prompt: 'Run a SQL query',
          capability: 'run_query',
          parameters: { sql: 'SELECT 1' },
        },
      });

      expect(createRes.statusCode).toBe(201);
      const createBody = createRes.json();
      expect(createBody.success).toBe(true);
      expect(createBody.data.taskId).toBeDefined();
      expect(createBody.traceId).toBeDefined();

      const taskId = createBody.data.taskId;

      // Step 2: Delegate task
      const delegateRes = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/delegate`,
        headers: { 'x-bot-id': 'bot-a' },
        payload: { toBotId: 'bot-b' },
      });

      expect(delegateRes.statusCode).toBe(200);
      const delegateBody = delegateRes.json();
      expect(delegateBody.success).toBe(true);
      expect(delegateBody.data.taskId).toBe(taskId);
      expect(delegateBody.data.toBotId).toBe('bot-b');
    });

    it('should return 400 for missing toBotId on delegate', async () => {
      const task = await coordinator.createTask(
        { prompt: 'test', capability: 'test', parameters: {} },
        'bot-a'
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/delegate`,
        headers: { 'x-bot-id': 'bot-a' },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.success).toBe(false);
    });

    it('should allow executor to sub-delegate and return sub-task id', async () => {
      const task = await coordinator.createTask(
        { prompt: 'test', capability: 'test', parameters: {} },
        'bot-a'
      );
      await coordinator.delegate(task.id, 'bot-b');
      await coordinator.accept(task.id, 'bot-b');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/delegate`,
        headers: { 'x-bot-id': 'bot-b' },
        payload: { toBotId: 'bot-c', subTaskPrompt: 'implement parser only' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.delegationMode).toBe('sub-task');
      expect(body.data.parentTaskId).toBe(task.id);
      expect(body.data.taskId).not.toBe(task.id);
    });

    it('should reject executor direct-delegate without subTaskPrompt', async () => {
      const task = await coordinator.createTask(
        { prompt: 'test', capability: 'test', parameters: {} },
        'bot-a'
      );
      await coordinator.delegate(task.id, 'bot-b');
      await coordinator.accept(task.id, 'bot-b');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/delegate`,
        headers: { 'x-bot-id': 'bot-b' },
        payload: { toBotId: 'bot-c' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should allow delegator to sub-delegate when subTaskPrompt is provided', async () => {
      const task = await coordinator.createTask(
        { prompt: 'test', capability: 'test', parameters: {} },
        'bot-a'
      );
      await coordinator.delegate(task.id, 'bot-b');
      await coordinator.accept(task.id, 'bot-b');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/delegate`,
        headers: { 'x-bot-id': 'bot-a' },
        payload: { toBotId: 'bot-c', subTaskPrompt: 'split out performance benchmark' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.delegationMode).toBe('sub-task');
      expect(body.data.parentTaskId).toBe(task.id);
      expect(body.data.taskId).not.toBe(task.id);
    });

    it('should return 403 when unrelated bot tries to delegate the task', async () => {
      const task = await coordinator.createTask(
        { prompt: 'test', capability: 'test', parameters: {} },
        'bot-a'
      );
      await coordinator.delegate(task.id, 'bot-b');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/delegate`,
        headers: { 'x-bot-id': 'bot-z' },
        payload: { toBotId: 'bot-c', subTaskPrompt: 'x' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should return 409 when task is no longer pending', async () => {
      const task = await coordinator.createTask(
        { prompt: 'test', capability: 'test', parameters: {} },
        'bot-a'
      );
      await coordinator.delegate(task.id, 'bot-b');
      await coordinator.accept(task.id, 'bot-b');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/delegate`,
        headers: { 'x-bot-id': 'bot-a' },
        payload: { toBotId: 'bot-c' },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  // ===== GET /pending =====

  describe('GET /api/v1/tasks/pending', () => {
    it('should return pending tasks', async () => {
      await createAndDelegate(
        coordinator,
        { toBotId: 'bot-b', prompt: 'test task', capability: 'test', parameters: {} },
        'bot-a'
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tasks/pending',
        headers: { 'x-bot-id': 'bot-b' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.tasks).toHaveLength(1);
    });

    it('should return empty array for bot with no tasks', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tasks/pending',
        headers: { 'x-bot-id': 'bot-z' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.tasks).toHaveLength(0);
    });
  });

  // ===== POST /:taskId/accept =====

  describe('POST /api/v1/tasks/:taskId/accept', () => {
    it('should accept a pending task', async () => {
      const task = await createAndDelegate(
        coordinator,
        { toBotId: 'bot-b', prompt: 'test task', capability: 'test', parameters: {} },
        'bot-a'
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/accept`,
        headers: { 'x-bot-id': 'bot-b' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('processing');
    });

    it('should return 403 for wrong bot', async () => {
      const task = await createAndDelegate(
        coordinator,
        { toBotId: 'bot-b', prompt: 'test task', capability: 'test', parameters: {} },
        'bot-a'
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/accept`,
        headers: { 'x-bot-id': 'bot-c' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should return 404 for non-existent task', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tasks/non-existent/accept',
        headers: { 'x-bot-id': 'bot-b' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ===== POST /:taskId/complete =====

  describe('POST /api/v1/tasks/:taskId/complete', () => {
    it('should complete a task with result', async () => {
      const task = await createAndDelegate(
        coordinator,
        { toBotId: 'bot-b', prompt: 'test task', capability: 'test', parameters: {} },
        'bot-a'
      );
      await coordinator.accept(task.id, 'bot-b');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/complete`,
        headers: { 'x-bot-id': 'bot-b' },
        payload: {
          status: 'completed',
          result: { answer: 42 },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.status).toBe('completed');
    });
  });

  // ===== POST /:taskId/cancel =====

  describe('POST /api/v1/tasks/:taskId/cancel', () => {
    it('should cancel a pending task', async () => {
      const task = await createAndDelegate(
        coordinator,
        { toBotId: 'bot-b', prompt: 'test task', capability: 'test', parameters: {} },
        'bot-a'
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/cancel`,
        headers: { 'x-bot-id': 'bot-a' },
        payload: { reason: 'No longer needed' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.status).toBe('cancelled');
    });

    it('should return 403 for non-sender', async () => {
      const task = await createAndDelegate(
        coordinator,
        { toBotId: 'bot-b', prompt: 'test task', capability: 'test', parameters: {} },
        'bot-a'
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/cancel`,
        headers: { 'x-bot-id': 'bot-b' },
        payload: { reason: 'nope' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ===== GET /:taskId =====

  describe('GET /api/v1/tasks/:taskId', () => {
    it('should return task details for authorized bot', async () => {
      const task = await createAndDelegate(
        coordinator,
        { toBotId: 'bot-b', prompt: 'test task', capability: 'test', parameters: {} },
        'bot-a'
      );

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tasks/${task.id}`,
        headers: { 'x-bot-id': 'bot-a' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.id).toBe(task.id);
      expect(body.data.capability).toBe('test');
    });

    it('should return 404 for unauthorized bot', async () => {
      const task = await createAndDelegate(
        coordinator,
        { toBotId: 'bot-b', prompt: 'test task', capability: 'test', parameters: {} },
        'bot-a'
      );

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tasks/${task.id}`,
        headers: { 'x-bot-id': 'bot-c' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ===== GET / =====

  describe('GET /api/v1/tasks', () => {
    it('should return paginated task list', async () => {
      await createAndDelegate(
        coordinator,
        { toBotId: 'bot-b', prompt: 'test task 1', capability: 'test1', parameters: {} },
        'bot-a'
      );
      await createAndDelegate(
        coordinator,
        { toBotId: 'bot-b', prompt: 'test task 2', capability: 'test2', parameters: {} },
        'bot-a'
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tasks?role=from',
        headers: { 'x-bot-id': 'bot-a' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.items).toHaveLength(2);
      expect(body.data.total).toBe(2);
    });
  });
});
