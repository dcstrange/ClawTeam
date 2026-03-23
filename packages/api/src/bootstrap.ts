/**
 * Bootstrap - 服务初始化和依赖注入
 *
 * 整合所有核心模块：
 * - Database (PostgreSQL)
 * - Redis
 * - Capability Registry
 * - Message Bus
 * - Task Coordinator
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { getConfig, AppConfig } from './common/config';
import { getDatabase, DatabasePool, closeDatabase } from './common/db';
import { getRedis, RedisClient, closeRedis } from './common/redis';
import { createLogger, Logger } from './common/logger';
import { ClawTeamError, wrapError } from './common/errors';

import { createCapabilityRegistry, ICapabilityRegistry, createUserRepository } from './capability-registry';
import { createRegistryRoutes } from './capability-registry/routes';
import messageBusPlugin, { IMessageBus } from './message-bus';
import { createTaskCoordinator, ITaskCoordinator } from './task-coordinator';
import { createTaskRoutes } from './task-coordinator/routes';
import { PrimitiveService, IPrimitiveService } from './primitives';
import { createMessageRoutes } from './messages';
import { createPrimitiveRoutes } from './primitives/routes';
import { createFileRoutes } from './file-service';

/**
 * 应用上下文 - 包含所有核心服务实例
 */
export interface AppContext {
  config: AppConfig;
  db: DatabasePool;
  redis: RedisClient;
  logger: Logger;
  registry: ICapabilityRegistry;
  messageBus: IMessageBus;
  taskCoordinator: ITaskCoordinator;
  primitiveService: IPrimitiveService;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveFileServiceOpenApiPath(): string | null {
  const candidates = [
    resolve(process.cwd(), 'docs/api-reference/openapi-file-service.yaml'),
    resolve(process.cwd(), '../../docs/api-reference/openapi-file-service.yaml'),
    resolve(__dirname, '../../../docs/api-reference/openapi-file-service.yaml'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function renderSwaggerDocsHtml(fileServiceSpecUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ClawTeam API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; }
    .topbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px; border-bottom: 1px solid #e5e7eb; background: #fff;
    }
    .topbar h1 { margin: 0; font-size: 14px; font-weight: 600; color: #111827; }
    .topbar a { color: #1d4ed8; text-decoration: none; font-size: 12px; }
    #swagger-ui { max-width: 1200px; margin: 0 auto; }
  </style>
</head>
<body>
  <div class="topbar">
    <h1>ClawTeam API Docs</h1>
    <a href="${fileServiceSpecUrl}" target="_blank" rel="noreferrer">Open file-service OpenAPI YAML</a>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: "${fileServiceSpecUrl}",
      dom_id: '#swagger-ui',
      deepLinking: true,
      displayRequestDuration: true
    });
  </script>
</body>
</html>`;
}

/**
 * 初始化基础设施 (Database, Redis)
 */
async function initInfrastructure(logger: Logger): Promise<{ db: DatabasePool; redis: RedisClient }> {
  logger.info('Initializing infrastructure...');

  // 初始化数据库
  logger.info('Connecting to PostgreSQL...');
  const db = getDatabase();

  // 验证数据库连接
  try {
    await db.query('SELECT 1');
    logger.info('PostgreSQL connected successfully');
  } catch (error) {
    logger.error('Failed to connect to PostgreSQL', { error });
    throw error;
  }

  // 初始化 Redis
  logger.info('Connecting to Redis...');
  const redis = getRedis();

  // 验证 Redis 连接
  try {
    await redis.set('_health_check', 'ok', 10);
    const value = await redis.get('_health_check');
    if (value === 'ok') {
      logger.info('Redis connected successfully');
    }
  } catch (error) {
    logger.warn('Redis connection failed, some features may be degraded', { error });
    // Redis 失败不阻止启动，但会影响部分功能
  }

  return { db, redis };
}

/**
 * 初始化核心服务
 */
async function initServices(
  db: DatabasePool,
  redis: RedisClient,
  logger: Logger
): Promise<{ registry: ICapabilityRegistry }> {
  logger.info('Initializing core services...');

  // 创建 Capability Registry
  const registry = createCapabilityRegistry({
    db,
    redis,
    logger: createLogger('capability-registry'),
  });

  logger.info('Core services initialized');
  return { registry };
}

/**
 * 创建 Fastify 服务器并注册所有插件和路由
 */
export async function createServer(): Promise<{ server: FastifyInstance; context: AppContext }> {
  const config = getConfig();
  const logger = createLogger('bootstrap');

  logger.info('Starting ClawTeam Platform API...', {
    nodeEnv: process.env.NODE_ENV,
    port: config.api.port,
  });

  // 初始化基础设施
  const { db, redis } = await initInfrastructure(logger);

  // 初始化核心服务
  const { registry } = await initServices(db, redis, logger);

  // 创建 Fastify 实例
  const server = Fastify({
    logger: {
      level: config.logLevel,
    },
  });

  const corsOriginRaw = process.env.CORS_ORIGIN?.trim();
  const corsOrigin =
    !corsOriginRaw || corsOriginRaw === '*'
      ? true
      : (corsOriginRaw.includes(',')
        ? corsOriginRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : corsOriginRaw);

  // 注册 CORS
  // @ts-expect-error - fastify/cors types mismatch with fastify 4.x
  await server.register(fastifyCors, {
    origin: corsOrigin,
    credentials: true,
  });

  // 注册 Message Bus 插件 (包含 WebSocket 支持)
  await server.register(messageBusPlugin, {
    redis: config.redis,
    registry,
  });

  // 获取 MessageBus 实例
  const messageBus = (server as any).messageBus as IMessageBus;

  // 创建 Task Coordinator
  const taskCoordinator = createTaskCoordinator({
    db,
    redis,
    registry,
    messageBus,
    logger: createLogger('task-coordinator'),
  });

  // 创建 Primitive Service
  const primitiveService = new PrimitiveService({
    registry,
    messageBus,
    taskCoordinator,
    redis,
    db,
  });

  // 构建应用上下文
  const context: AppContext = {
    config,
    db,
    redis,
    logger,
    registry,
    messageBus,
    taskCoordinator,
    primitiveService,
  };

  // 将上下文注入到 Fastify 实例
  server.decorate('context', context);

  // 注册全局错误处理
  server.setErrorHandler((error, request, reply) => {
    const clawTeamError = wrapError(error);

    server.log.error({
      err: error,
      requestId: request.id,
      path: request.url,
      method: request.method,
    });

    reply.status(clawTeamError.statusCode).send({
      success: false,
      error: clawTeamError.toJSON(),
      traceId: request.id,
    });
  });

  // 健康检查路由 (message-bus plugin 已经在 /health 提供了基础版本)
  // 这里提供更详细的 /api/health 端点
  server.get('/api/health', async (request, reply) => {
    const dbHealthy = db.isConnected();
    const redisHealthy = redis.isConnected();

    const status = dbHealthy && redisHealthy ? 'healthy' : 'degraded';
    const statusCode = dbHealthy ? 200 : 503;

    return reply.status(statusCode).send({
      status,
      timestamp: new Date().toISOString(),
      services: {
        database: dbHealthy ? 'connected' : 'disconnected',
        redis: redisHealthy ? 'connected' : 'disconnected',
      },
    });
  });

  const fileServiceOpenApiPath = resolveFileServiceOpenApiPath();

  // OpenAPI spec route (file service)
  server.get('/api/v1/openapi/file-service.yaml', async (_request, reply) => {
    if (!fileServiceOpenApiPath) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'OPENAPI_SPEC_NOT_FOUND',
          message: 'openapi-file-service.yaml not found in workspace',
        },
      });
    }
    const content = await readFile(fileServiceOpenApiPath, 'utf8');
    reply
      .header('cache-control', 'public, max-age=60')
      .type('application/yaml; charset=utf-8');
    return reply.send(content);
  });

  // Swagger docs site
  server.get('/docs', async (_request, reply) => {
    const html = renderSwaggerDocsHtml('/api/v1/openapi/file-service.yaml');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // API docs index
  server.get('/api/v1', async () => ({
    name: 'ClawTeam API docs index',
    swaggerUi: '/docs',
    openapi: {
      fileService: '/api/v1/openapi/file-service.yaml',
    },
    notes: [
      'Markdown docs are in workspace: docs/api-reference/FILE_SERVICE_API.md',
      'Markdown docs are in workspace: docs/api-reference/REST_API.md',
    ],
  }));

  // 注册 API 路由
  await server.register(
    async (fastify) => {
      // Registry 路由 (内部已定义 /bots, /capabilities, /capability-registry 前缀)
      const userRepo = createUserRepository(db);
      await fastify.register(createRegistryRoutes({ registry, db, userRepo }));

      // Task 相关路由
      await fastify.register(createTaskRoutes({ coordinator: taskCoordinator, registry, userRepo, db, redis }), { prefix: '/tasks' });

      // Message 收件箱路由
      await fastify.register(createMessageRoutes({ db, redis, registry, userRepo }), { prefix: '/messages' });

      // File Service 路由
      await fastify.register(createFileRoutes({ db, registry, userRepo }), { prefix: '/files' });

      // Primitive 元数据路由
      await fastify.register(createPrimitiveRoutes({ primitiveService }), { prefix: '/primitives' });
    },
    { prefix: '/api/v1' }
  );

  // 根路由 - API 信息
  server.get('/', async () => {
    return {
      name: 'ClawTeam Platform API',
      version: '1.0.0',
      docs: '/docs',
      health: '/health',
      websocket: '/ws',
      openapi: '/api/v1/openapi/file-service.yaml',
      endpoints: {
        tasks: '/api/v1/tasks',
        files: '/api/v1/files',
        messages: '/api/v1/messages',
        primitives: '/api/v1/primitives',
        bots: '/api/v1/bots',
      },
    };
  });

  logger.info('Server created successfully');

  return { server, context };
}

/**
 * 启动服务器
 */
export async function startServer(server: FastifyInstance, port?: number): Promise<string> {
  const config = getConfig();
  const actualPort = port || config.api.port;

  const address = await server.listen({
    port: actualPort,
    host: config.api.host,
  });

  return address;
}

/**
 * 优雅关闭
 */
export async function shutdown(server: FastifyInstance): Promise<void> {
  const logger = createLogger('shutdown');

  logger.info('Shutting down server...');

  try {
    await server.close();
    logger.info('Fastify server closed');
  } catch (error) {
    logger.error('Error closing Fastify server', { error });
  }

  try {
    await closeDatabase();
    logger.info('Database connection closed');
  } catch (error) {
    logger.error('Error closing database', { error });
  }

  try {
    await closeRedis();
    logger.info('Redis connection closed');
  } catch (error) {
    logger.error('Error closing Redis', { error });
  }

  logger.info('Shutdown complete');
}

// 声明 Fastify 装饰器类型
declare module 'fastify' {
  interface FastifyInstance {
    context: AppContext;
  }
}
