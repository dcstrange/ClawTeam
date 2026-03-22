# 平台层 — @clawteam/api

> ⚠️ Historical Notice: 本文档含历史语义，可能与当前实现不一致。
> 当前规范请优先参考：`docs/task-operations/README.md`、`docs/api-reference/api-endpoints.md`、`docs/Gateway/GATEWAY_TASK_MANAGEMENT.md`。

> API Server 是整个 ClawTeam Platform 的中枢，提供 REST API + WebSocket 服务

## 1. 概述

平台层是一个基于 Fastify 4 的 HTTP + WebSocket 服务器，端口 3000，包含三个核心子模块和一个预留模块：

| 子模块 | 职责 | 依赖 |
|--------|------|------|
| Capability Registry | Bot 注册、能力索引、搜索、API Key 认证 | PostgreSQL |
| Task Coordinator | 任务委派、生命周期管理、超时检测、重试 | PostgreSQL, Redis, MessageBus, Registry |
| Message Bus | WebSocket 连接管理、Redis Pub/Sub 事件分发 | Redis |
| Primitives | L0-L3 原语操作（Phase 3 预留） | Registry, Coordinator |

---

## 2. 目录结构

```
packages/api/src/
├── server.ts                    # Fastify 启动入口
├── bootstrap.ts                 # 依赖注入和模块组装
├── common/
│   ├── config.ts                # 环境变量配置
│   ├── db.ts                    # PostgreSQL 连接池 (pg)
│   ├── redis.ts                 # Redis 连接 (ioredis)
│   ├── logger.ts                # Pino logger
│   └── errors.ts                # 通用错误类
│
├── capability-registry/
│   ├── interface.ts             # ICapabilityRegistry 接口定义
│   ├── registry.ts              # 实现 (PostgreSQL)
│   ├── repository.ts            # 数据访问层
│   ├── searcher.ts              # 能力搜索引擎 (pg_trgm)
│   ├── cache.ts                 # Redis 缓存层
│   ├── types.ts                 # 模块内部类型
│   ├── constants.ts             # 常量 (邀请码等)
│   ├── errors.ts                # 模块错误类
│   ├── mocks.ts                 # MockCapabilityRegistry
│   ├── middleware/auth.ts       # API Key 认证中间件
│   ├── utils/
│   │   ├── api-key.ts           # API Key 生成和哈希
│   │   ├── similarity.ts        # 文本相似度算法
│   │   └── time-parser.ts       # 时间字符串解析
│   ├── schemas/                 # JSON Schema 验证
│   │   ├── register.schema.ts
│   │   ├── search.schema.ts
│   │   └── update.schema.ts
│   └── routes/
│       ├── index.ts             # 路由注册
│       ├── bots.ts              # Bot CRUD 端点
│       ├── capabilities.ts      # 能力搜索端点
│       └── health.ts            # 健康检查端点
│
├── task-coordinator/
│   ├── interface.ts             # ITaskCoordinator 接口定义
│   ├── coordinator-impl.ts      # 实现 (组合 dispatcher + completer)
│   ├── dispatcher.ts            # 任务入队和分发 (Redis 队列)
│   ├── completer.ts             # 状态转换逻辑 (accept/start/complete/cancel/reset)
│   ├── timeout-detector.ts      # 超时检测和自动重试
│   ├── poller.ts                # Redis 队列消费者
│   ├── metrics.ts               # Prometheus 指标
│   ├── types.ts                 # 模块内部类型
│   ├── constants.ts             # 状态常量、默认超时
│   ├── errors.ts                # 模块错误类
│   ├── mocks.ts                 # MockTaskCoordinator
│   ├── middleware/auth.ts       # 任务操作鉴权
│   └── routes/
│       ├── index.ts             # 任务 REST 端点 (18 个)
│       ├── health.ts            # 健康检查
│       └── metrics.ts           # Prometheus 端点
│
├── message-bus/
│   ├── interface.ts             # IMessageBus + 配置类型
│   ├── message-bus.ts           # 实现 (Redis Pub/Sub)
│   ├── websocket-manager.ts     # WebSocket 连接管理
│   ├── heartbeat-manager.ts     # Ping/Pong 心跳检测
│   ├── ack-tracker.ts           # 消息确认追踪
│   ├── offline-queue.ts         # 离线消息队列
│   ├── message-store.ts         # 消息持久化
│   ├── retry-manager.ts         # 指数退避重试
│   ├── pubsub-bridge.ts         # Redis Pub/Sub 桥接
│   ├── plugin.ts                # Fastify WebSocket 插件
│   ├── errors.ts                # 模块错误类
│   └── mocks.ts                 # MockMessageBus
│
└── primitives/                  # Phase 3 预留
    ├── interface.ts
    ├── service.ts
    ├── l0-primitives.ts
    ├── l1-primitives.ts
    ├── l2-primitives.ts
    └── l3-primitives.ts
```

---

## 3. 能力注册中心 (Capability Registry)

### 3.1 接口

```typescript
interface ICapabilityRegistry {
  register(req: BotRegisterRequest): Promise<BotRegisterResponse>;
  updateCapabilities(botId: string, capabilities: BotCapability[]): Promise<CapabilityUpdateResponse>;
  getBot(botId: string): Promise<Bot | null>;
  search(query: CapabilitySearchQuery): Promise<PaginatedResponse<CapabilityMatch>>;
  findByCapability(capabilityName: string): Promise<Bot[]>;
  updateStatus(botId: string, status: BotStatus): Promise<void>;
  heartbeat(botId: string): Promise<HeartbeatResponse>;
  validateApiKey(apiKey: string): Promise<Bot | null>;
}
```

### 3.2 注册流程

```
1. 客户端提交 name, ownerEmail, capabilities
2. 生成 botId (UUID) 和 API Key (随机 32 字节 hex)
3. 存储 API Key 的 SHA-256 哈希 (明文不存储)
4. 写入 bots 表 + capability_index 表
5. 返回 { botId, apiKey } — apiKey 仅此一次返回
```

### 3.3 搜索机制

- 使用 PostgreSQL `pg_trgm` 扩展进行模糊匹配
- `similarity()` 函数计算文本相似度分数
- 支持按 tags、maxResponseTime、async 过滤
- 结果按相似度分数降序排列，支持分页

### 3.4 认证中间件

```
请求 → x-api-key header → SHA-256 哈希 → 查询 bots 表
  ├─ 匹配 → 注入 botId 到请求上下文
  └─ 不匹配 → 401 Unauthorized
```

### 3.5 数据模型

**bots 表：**
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| team_id | UUID | 所属团队 |
| name | VARCHAR | Bot 名称 |
| owner_email | VARCHAR | 所有者邮箱 |
| api_key_hash | VARCHAR | API Key SHA-256 哈希 |
| status | ENUM | online/offline/busy/focus_mode |
| capabilities | JSONB | 能力声明数组 |
| tags | TEXT[] | 标签 |
| availability | JSONB | 可用性配置 |
| created_at | TIMESTAMP | 创建时间 |
| last_seen | TIMESTAMP | 最后心跳时间 |

---

## 4. 任务协调器 (Task Coordinator)

### 4.1 接口

```typescript
interface ITaskCoordinator {
  delegate(req: TaskDelegateRequest, fromBotId: string): Promise<Task>;
  poll(botId: string, limit?: number): Promise<Task[]>;
  accept(taskId: string, botId: string, executorSessionKey?: string): Promise<void>;
  start(taskId: string, botId: string): Promise<void>;
  complete(taskId: string, req: TaskCompleteRequest, botId: string): Promise<void>;
  cancel(taskId: string, reason: string, botId: string): Promise<void>;
  reset(taskId: string, botId: string): Promise<void>;
  getTask(taskId: string, botId: string): Promise<Task | null>;
  getTasksByBot(botId: string, options?: TaskQueryOptions): Promise<PaginatedResponse<Task>>;
  retry(taskId: string): Promise<void>;
  cleanupExpiredTasks(): Promise<number>;
}
```

### 4.2 任务状态机

```
                    cancel (fromBot)
              ┌──────────────────────┐
              │                      ▼
  delegate → pending → accepted → processing → completed
                                            ↘ failed
                                            ↘ timeout
              ↑                                │
              └────── reset (recovery) ────────┘
```

**状态转换规则：**
| 转换 | 触发者 | 前置状态 | API |
|------|--------|---------|-----|
| → pending | fromBot | (新建) | POST /delegate |
| pending → accepted | toBotId | pending | POST /:id/accept |
| accepted → processing | toBotId | accepted | POST /:id/start |
| processing → completed | toBotId | accepted/processing | POST /:id/complete |
| processing → failed | toBotId | accepted/processing | POST /:id/complete (with error) |
| pending/accepted → cancelled | fromBotId | pending/accepted | POST /:id/cancel |
| accepted/processing → pending | toBotId | accepted/processing | POST /:id/reset |
| (auto) → timeout | TimeoutDetector | processing | 自动 |
| (auto) → pending | TimeoutDetector | timeout | 自动重试 (retryCount < maxRetries) |

### 4.3 内部组件

**Dispatcher** — 任务入队
- 创建任务记录 (PostgreSQL)
- 入 Redis 优先级队列 (`clawteam:tasks:pending:{toBotId}`)
- 发布 `task_assigned` 事件

**Completer** — 状态转换
- 严格校验前置状态，不符合抛 `InvalidTaskStateError` (409)
- 校验操作者身份 (toBotId/fromBotId)
- 完成时发布 `task_completed` 或 `task_failed` 事件

**TimeoutDetector** — 超时检测
- 定时扫描 (默认 60s 间隔)
- 检测超过 `timeout_seconds` 的 processing 任务
- retryCount < maxRetries (默认 3) → 重置为 pending，retryCount++
- retryCount >= maxRetries → 标记为 timeout，发布 `task_failed`

**Poller** — Redis 队列消费
- 非破坏性读取 (LRANGE)，任务留在队列直到 accept
- 按优先级排序: urgent > high > normal > low

### 4.4 数据模型

**tasks 表：**
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| from_bot_id | UUID | 委派方 |
| to_bot_id | UUID | 执行方 |
| capability | VARCHAR | 能力名称 |
| parameters | JSONB | 任务参数 |
| status | VARCHAR | 当前状态 |
| priority | VARCHAR | low/normal/high/urgent |
| type | VARCHAR | new/sub-task |
| parent_task_id | UUID | 父任务 (sub-task) |
| sender_session_key | VARCHAR | 委派方 session key |
| executor_session_key | VARCHAR | 执行方 session key |
| result | JSONB | 执行结果 |
| error | JSONB | 错误信息 |
| timeout_seconds | INT | 超时时间 (默认 3600) |
| retry_count | INT | 已重试次数 |
| max_retries | INT | 最大重试次数 (默认 3) |
| human_context | TEXT | 人类上下文说明 |
| created_at | TIMESTAMP | 创建时间 |
| accepted_at | TIMESTAMP | 接受时间 |
| started_at | TIMESTAMP | 开始时间 |
| completed_at | TIMESTAMP | 完成时间 |

---

## 5. 消息总线 (Message Bus)

### 5.1 接口

```typescript
interface IMessageBus {
  publish(event: MessageType, payload: unknown, targetBotId?: string): Promise<void>;
  subscribe(botId: string, handler: MessageHandler): Promise<void>;
  unsubscribe(botId: string): Promise<void>;
  updateBotStatus(botId: string, status: BotStatus): Promise<void>;
  getOnlineBots(): Promise<string[]>;
  isBotOnline(botId: string): Promise<boolean>;
  close(): Promise<void>;
}
```

### 5.2 架构

```
Bot A (WebSocket) ──┐
Bot B (WebSocket) ──┤
Bot C (WebSocket) ──┤
                    ▼
            WebSocketManager
                    │
                    ├── HeartbeatManager (ping/pong 30s)
                    ├── AckTracker (消息确认)
                    ├── OfflineQueue (离线暂存)
                    └── MessageStore (持久化)
                    │
                    ▼
              PubSubBridge
                    │
                    ▼
              Redis Pub/Sub
              (7 个频道)
```

### 5.3 Redis Pub/Sub 频道

| 频道 | 事件类型 | 说明 |
|------|---------|------|
| `clawteam:events:task_assigned` | task_assigned | 任务被委派 |
| `clawteam:events:task_completed` | task_completed | 任务完成 |
| `clawteam:events:task_failed` | task_failed | 任务失败 |
| `clawteam:events:bot_status` | bot_status_changed | Bot 状态变更 |
| `clawteam:events:workflow_started` | workflow_started | 工作流启动 |
| `clawteam:events:workflow_completed` | workflow_completed | 工作流完成 |
| `clawteam:events:broadcast` | (广播) | 全局广播 |

### 5.4 高级特性 (可配置)

**心跳检测：**
- 间隔: 30s (configurable)
- 超时: 10s → 关闭连接 (close code 4004)
- 使用原生 WebSocket ping/pong 帧

**消息确认 (ACK)：**
- 可配置哪些事件类型需要 ACK
- 超时: 30s → 触发重试
- 消息携带 `messageId`，客户端回复 `{ action: "ack", payload: { messageId } }`

**离线队列：**
- Bot 离线时消息暂存 Redis (`clawteam:offline:{botId}`)
- 最大队列: 100 条/bot
- TTL: 24 小时
- 重连时自动 flush

**消息持久化：**
- 存储到 Redis (`clawteam:messages:{botId}`)
- TTL: 7 天
- 最大: 1000 条/bot

**重试机制：**
- 指数退避: baseDelay * 2^attempt
- 最大重试: 3 次
- 最大延迟: 30s

---

## 6. 认证机制

```
                    ┌─────────────────────┐
                    │   HTTP 请求          │
                    │   x-api-key: xxx    │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Auth Middleware    │
                    │   SHA-256(apiKey)   │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Registry          │
                    │   .validateApiKey() │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   bots 表查询       │
                    │   WHERE hash = ?    │
                    └──────────┬──────────┘
                               │
                  ┌────────────┴────────────┐
                  │                         │
           ┌──────▼──────┐          ┌──────▼──────┐
           │  匹配        │          │  不匹配      │
           │  注入 botId  │          │  401 返回    │
           └─────────────┘          └─────────────┘
```

**公开端点 (无需认证)：**
- 健康检查: `/api/health`, `/api/v1/*/health`
- Bot 列表: `GET /api/v1/bots`
- 能力搜索: `POST /api/v1/capabilities/search`
- Dashboard 端点: `GET /api/v1/tasks/all`

---

## 7. 配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `DATABASE_URL` | - | PostgreSQL 连接字符串 |
| `REDIS_URL` | `redis://localhost:6379` | Redis 连接字符串 |
| `PORT` | `3000` | HTTP 端口 |
| `LOG_LEVEL` | `info` | 日志级别 |
| `USE_MOCK` | `false` | 使用 Mock 实现 |
| `TIMEOUT_CHECK_INTERVAL_MS` | `60000` | 超时检测间隔 |
| `DEFAULT_TASK_TIMEOUT_SECONDS` | `3600` | 默认任务超时 |
| `DEFAULT_MAX_RETRIES` | `3` | 默认最大重试次数 |

---

## 8. 测试

- 323 tests, ~85% coverage
- capability-registry: 105 tests (100% coverage)
- message-bus: 118 tests (83.46% coverage)
- task-coordinator: 94 tests (>80% coverage)
- 包含集成测试 (需要 PostgreSQL + Redis)

---

## 9. 已知限制

- Dashboard admin 端点 (`/api/v1/tasks/all/*`) 无鉴权，仅适用于内网
- `POST /tasks/:id/reset` 端点尚未实现（计划中）
- Workflow Engine 和 Permission Manager 为 Phase 3 占位
- 无 rate limiting
- 单实例部署，未做水平扩展适配（Redis 队列支持，但需要分布式锁）
