# ClawTeam Platform — TypeScript 接口参考文档

> ⚠️ Historical Notice: 本文档含历史语义，可能与当前实现不一致。
> 当前规范请优先参考：`docs/task-operations/README.md`、`docs/api-reference/api-endpoints.md`、`docs/Gateway/GATEWAY_TASK_MANAGEMENT.md`。

> 本文档完整记录 ClawTeam Platform 中所有 TypeScript 接口、类型别名和核心类的定义。
> 适用于平台开发者、Bot SDK 集成方以及需要实现 Mock/真实适配器的工程师。

---

## 目录

1. [概述 — 接口设计原则](#1-概述--接口设计原则)
2. [共享类型 (Shared Types)](#2-共享类型-shared-types)
3. [平台层接口](#3-平台层接口)
4. [路由层接口](#4-路由层接口)
5. [监控类型](#5-监控类型)
6. [服务器类型](#6-服务器类型)
7. [接口依赖图](#7-接口依赖图)

---

## 1. 概述 — 接口设计原则

ClawTeam Platform 的类型系统遵循三大核心原则：

### 1.1 依赖注入 (Dependency Injection)

每个核心模块导出一个 `I*` 接口（如 `ICapabilityRegistry`、`ITaskCoordinator`、`IMessageBus`），上层模块通过构造函数注入依赖，而非直接 import 具体实现。这使得模块间解耦，便于替换实现。

```typescript
// TaskCoordinator 通过构造函数接收依赖
constructor(
  registry: ICapabilityRegistry,  // 注入接口，而非具体类
  messageBus: IMessageBus,
) { ... }
```

### 1.2 Mock-First 开发

每个接口都有对应的 Mock 实现（如 `MockCapabilityRegistry`），允许各模块并行开发。通过 `USE_MOCK` 环境变量切换真实/Mock 实现。

### 1.3 契约驱动 (Contract-Driven)

所有 API 响应统一使用 `ApiResponse<T>` 和 `PaginatedResponse<T>` 包装，携带 `traceId` 用于分布式追踪。接口定义即契约，真实实现和 Mock 实现必须满足同一接口。

---

## 2. 共享类型 (Shared Types)

> 定义位置：`packages/shared/types/index.ts`
> 被所有模块引用，是整个平台的类型基础。

### 2.1 Bot 相关类型

#### BotCapability

Bot 声明的单项能力。

```typescript
interface BotCapability {
  /** 能力名称，如 "code_search", "run_tests" */
  name: string;
  /** 能力描述 */
  description: string;
  /** 参数 schema */
  parameters: Record<string, {
    type: string;
    description?: string;
    required?: boolean;
  }>;
  /** 是否异步执行 */
  async: boolean;
  /** 预估执行时间，如 "5s", "2m" */
  estimatedTime: string;
}
```

#### BotAvailability

Bot 的可用性配置。

```typescript
interface BotAvailability {
  /** 时区，如 "UTC-8" */
  timezone: string;
  /** 工作时间，如 "09:00-18:00" */
  workingHours: string;
  /** 离线时是否自动响应 */
  autoRespond: boolean;
}
```

#### Bot

Bot 完整实体。

```typescript
interface Bot {
  /** Bot 唯一标识 */
  id: string;
  /** 所属团队 */
  teamId: string;
  /** Bot 名称 */
  name: string;
  /** 所有者邮箱 */
  ownerEmail: string;
  /** API Key 哈希（不存储明文） */
  apiKeyHash: string;
  /** 当前状态 */
  status: 'online' | 'offline' | 'busy' | 'focus_mode';
  /** 能力列表 */
  capabilities: BotCapability[];
  /** 标签，用于分类和搜索 */
  tags: string[];
  /** 可用性配置 */
  availability: BotAvailability;
  /** 创建时间 */
  createdAt: string;
  /** 最后在线时间 */
  lastSeen: string;
}
```

### 2.2 Task 相关类型

#### 类型别名

```typescript
type TaskStatus = 'pending' | 'accepted' | 'processing' | 'completed' | 'failed' | 'timeout';
type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
type TaskType = 'new' | 'sub-task';
```

#### Task

任务完整实体，贯穿整个任务生命周期。

```typescript
interface Task {
  /** 任务唯一标识 */
  id: string;
  /** 发起 Bot */
  fromBotId: string;
  /** 目标 Bot */
  toBotId: string;
  /** 调用的能力 */
  capability: string;
  /** 参数 */
  parameters: Record<string, any>;
  /** 任务状态 */
  status: TaskStatus;
  /** 优先级 */
  priority: TaskPriority;
  /** 任务类型 (new=新任务, sub-task=子任务) */
  type?: TaskType;
  /** 父任务 ID (用于 sub-task 类型) */
  parentTaskId?: string;
  /** 委托方的会话标识 (OpenClaw sessionKey) */
  senderSessionKey?: string;
  /** 执行方的会话标识 (OpenClaw sessionKey) */
  executorSessionKey?: string;
  /** 执行结果 */
  result?: any;
  /** 错误信息 */
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  /** 超时时间（秒） */
  timeoutSeconds: number;
  /** 重试次数 */
  retryCount: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 创建时间 */
  createdAt: string;
  /** 接受时间 */
  acceptedAt?: string;
  /** 开始时间 */
  startedAt?: string;
  /** 完成时间 */
  completedAt?: string;
  /** 人类上下文 */
  humanContext?: string;
  /** 所属对话 */
  conversationId?: string;
  /** 所属工作流 */
  workflowId?: string;
}
```

#### TaskDelegateRequest

委托任务时的请求体。

```typescript
interface TaskDelegateRequest {
  /** 目标 Bot */
  toBotId: string;
  /** 调用的能力 */
  capability: string;
  /** 参数 */
  parameters: Record<string, any>;
  /** 优先级 */
  priority?: TaskPriority;
  /** 任务类型 */
  type?: TaskType;
  /** 父任务 ID (用于 sub-task) */
  parentTaskId?: string;
  /** 委托方的会话标识 */
  senderSessionKey?: string;
  /** 超时时间（秒） */
  timeoutSeconds?: number;
  /** 人类上下文 */
  humanContext?: string;
}
```

#### TaskCompleteRequest

完成任务时的请求体。

```typescript
interface TaskCompleteRequest {
  /** 任务状态 */
  status: 'completed' | 'failed';
  /** 执行结果 */
  result?: any;
  /** 错误信息 */
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  /** 执行时间（毫秒） */
  executionTimeMs?: number;
  /** 是否忽略子任务未终态门禁（仅 delegator 使用） */
  force?: boolean;
}
```

### 2.3 Workflow 相关类型

```typescript
type WorkflowStatus = 'running' | 'completed' | 'failed' | 'cancelled';

interface WorkflowStep {
  /** 步骤 ID */
  id: string;
  /** 执行的 Bot */
  botId: string;
  /** 调用的能力 */
  capability: string;
  /** 参数 */
  parameters: Record<string, any>;
  /** 依赖的步骤 */
  dependsOn: string[];
  /** 超时时间（秒） */
  timeout?: number;
}

interface WorkflowDefinition {
  /** 工作流名称 */
  name: string;
  /** 描述 */
  description?: string;
  /** 步骤列表 */
  steps: WorkflowStep[];
}

interface Workflow {
  /** 工作流唯一标识 */
  id: string;
  /** 工作流名称 */
  name: string;
  /** 发起 Bot */
  initiatorBotId: string;
  /** 工作流定义 */
  definition: WorkflowDefinition;
  /** 工作流状态 */
  status: WorkflowStatus;
  /** 所有步骤的结果 */
  results: Record<string, any>;
  /** 创建时间 */
  createdAt: string;
  /** 完成时间 */
  completedAt?: string;
}

interface WorkflowExecuteRequest {
  /** 工作流名称或定义 */
  workflow: string | WorkflowDefinition;
  /** 参数 */
  parameters?: Record<string, any>;
}
```

### 2.4 Permission 相关类型

```typescript
interface BotPermission {
  /** Bot ID */
  botId: string;
  /** 可以查询的 Bot（'*' 表示所有） */
  canDiscover: string[];
  /** 可以委托的 Bot */
  canDelegateTo: string[];
  /** 可以访问的数据级别 */
  canAccessData: string[];
  /** 最大并发任务数 */
  maxConcurrentTasks: number;
  /** 限流配置 */
  rateLimit: {
    requestsPerMinute: number;
    tasksPerHour: number;
  };
}

interface AuditLog {
  /** 日志 ID */
  id: string;
  /** Bot ID */
  botId: string;
  /** 操作类型 */
  action: string;
  /** 资源类型 */
  resource: string;
  /** 资源 ID */
  resourceId?: string;
  /** 操作结果 */
  result: 'success' | 'failed';
  /** 时间戳 */
  timestamp: string;
  /** 元数据 */
  metadata?: Record<string, any>;
}
```

### 2.5 Message Bus 相关类型

```typescript
type MessageType =
  | 'task_assigned'
  | 'task_completed'
  | 'task_failed'
  | 'bot_status_changed'
  | 'workflow_started'
  | 'workflow_completed';

interface Message<T = any> {
  /** 消息类型 */
  type: MessageType;
  /** 消息负载 */
  payload: T;
  /** 时间戳 */
  timestamp: string;
  /** 追踪 ID */
  traceId?: string;
  /** 消息唯一标识（用于 ACK 确认） */
  messageId?: string;
}

interface BotStatusMessage {
  botId: string;
  status: Bot['status'];
  timestamp: string;
}

interface TaskMessage {
  taskId: string;
  fromBotId: string;
  toBotId: string;
  capability: string;
}
```

### 2.6 API 响应类型

```typescript
interface ApiResponse<T = any> {
  /** 是否成功 */
  success: boolean;
  /** 数据 */
  data?: T;
  /** 错误信息 */
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  /** 追踪 ID */
  traceId?: string;
}

interface PaginatedResponse<T> {
  /** 数据列表 */
  items: T[];
  /** 总数 */
  total: number;
  /** 当前页 */
  page: number;
  /** 每页数量 */
  pageSize: number;
  /** 是否有下一页 */
  hasMore: boolean;
}
```

### 2.7 Capability Search 相关类型

```typescript
interface CapabilitySearchQuery {
  /** 搜索关键词 */
  query: string;
  /** 过滤条件 */
  filters?: {
    tags?: string[];
    maxResponseTime?: string;
    async?: boolean;
  };
  /** 分页 */
  page?: number;
  pageSize?: number;
}

interface CapabilityMatch {
  /** Bot ID */
  botId: string;
  /** Bot 名称 */
  botName: string;
  /** 所有者 */
  ownerEmail: string;
  /** 匹配的能力 */
  capability: BotCapability;
  /** 匹配度（0-1） */
  confidence: number;
  /** 最后更新时间 */
  lastModified: string;
}
```

### 2.8 Team 相关类型

```typescript
interface Team {
  /** 团队 ID */
  id: string;
  /** 团队名称 */
  name: string;
  /** 团队标识符（用于 URL） */
  slug: string;
  /** 创建时间 */
  createdAt: string;
  /** 团队配置 */
  settings: Record<string, any>;
}

interface TeamInviteCode {
  /** 邀请码 */
  code: string;
  /** 所属团队 */
  teamId: string;
  /** 过期时间 */
  expiresAt: string;
  /** 是否已使用 */
  used: boolean;
}
```

---

## 3. 平台层接口

> 平台层接口定义在 `packages/api/src/` 下各模块的 `interface.ts` 中。
> 每个接口同时拥有真实实现（PostgreSQL/Redis）和 Mock 实现（内存 Map），通过工厂函数切换。

### 3.1 ICapabilityRegistry

> 定义位置：`packages/api/src/capability-registry/interface.ts`
> 职责：Bot 注册、能力声明、能力搜索、状态管理、API Key 验证。

#### 辅助类型

```typescript
/** Bot 注册请求 */
interface BotRegisterRequest {
  /** Bot 名称 */
  name: string;
  /** 所有者邮箱（可选，默认从认证用户获取） */
  ownerEmail?: string;
  /** 能力声明列表 */
  capabilities: BotCapability[];
  /** 标签 */
  tags?: string[];
  /** 可用性配置 */
  availability?: {
    timezone: string;
    workingHours: string;
    autoRespond: boolean;
  };
  /** 用户 ID（OpenClaw 用户邮箱） */
  userId?: string;
  /** 用户名称 */
  userName?: string;
  /** 客户端类型 */
  clientType?: 'openclaw' | 'custom' | 'sdk';
}

/** Bot 注册响应 */
interface BotRegisterResponse {
  /** Bot ID */
  botId: string;
}

/** 能力更新响应 */
interface CapabilityUpdateResponse {
  botId: string;
  capabilitiesCount: number;
  updatedAt: string;
}

/** 心跳响应 */
interface HeartbeatResponse {
  botId: string;
  status: Bot['status'];
  lastSeen: string;
}
```

#### 接口定义

```typescript
/**
 * 能力注册中心接口。
 * 真实实现使用 PostgreSQL + Redis 缓存，Mock 实现使用内存 Map。
 */
interface ICapabilityRegistry {
  /**
   * 注册新 Bot 及其能力。
   * 需要用户级 API Key 认证。返回 botId。
   */
  register(req: BotRegisterRequest, authenticatedUser?: UserRow): Promise<BotRegisterResponse>;

  /**
   * 更新 Bot 的能力列表。
   */
  updateCapabilities(botId: string, capabilities: BotCapability[]): Promise<CapabilityUpdateResponse>;

  /**
   * 根据 ID 获取 Bot 信息。
   * 未找到时返回 null。
   */
  getBot(botId: string): Promise<Bot | null>;

  /**
   * 搜索匹配查询条件的能力。
   * 返回带置信度评分的分页结果。
   */
  search(query: CapabilitySearchQuery): Promise<PaginatedResponse<CapabilityMatch>>;

  /**
   * 根据精确能力名称查找 Bot。
   */
  findByCapability(capabilityName: string): Promise<Bot[]>;

  /**
   * 更新 Bot 状态。
   */
  updateStatus(botId: string, status: Bot['status']): Promise<void>;

  /**
   * 记录 Bot 心跳。
   */
  heartbeat(botId: string): Promise<HeartbeatResponse>;

  /**
   * 验证 API Key 并返回关联的 Bot。
   * Key 无效时返回 null。
   */
  validateApiKey(apiKey: string): Promise<Bot | null>;
}
```

### 3.2 ITaskCoordinator

> 定义位置：`packages/api/src/task-coordinator/interface.ts`
> 职责：任务委托、轮询、接受、执行、完成、取消、重试、超时清理。
> 依赖：`ICapabilityRegistry`（验证 Bot 存在性）、`IMessageBus`（发布任务事件）。

#### 辅助类型

```typescript
/** 任务查询选项 */
interface TaskQueryOptions {
  /** 按 Bot 角色过滤：发送方、接收方或全部 */
  role?: 'from' | 'to' | 'all';
  /** 按任务状态过滤 */
  status?: TaskStatus[];
  /** 页码（从 1 开始） */
  page?: number;
  /** 每页数量 */
  limit?: number;
}

/** 任务委托响应 */
interface TaskDelegateResponse {
  taskId: string;
  status: TaskStatus;
  estimatedCompletion: string;
  trackingUrl: string;
}
```

#### 接口定义

```typescript
/**
 * 任务协调器接口。
 * 管理任务的完整生命周期：pending → accepted → processing → completed/failed。
 * 真实实现使用 Redis 优先级队列 + PostgreSQL 持久化。
 */
interface ITaskCoordinator {
  /**
   * 委托任务给目标 Bot。
   * 创建任务记录、入队并通知目标 Bot。
   * @throws TaskCoordinatorError 目标 Bot 不存在或队列已满时抛出
   */
  delegate(req: TaskDelegateRequest, fromBotId: string): Promise<Task>;

  /**
   * 轮询 Bot 的待处理任务，按优先级排序（urgent > high > normal > low）。
   * 非破坏性读取 — 任务在被接受前保留在队列中。
   */
  poll(botId: string, limit?: number): Promise<Task[]>;

  /**
   * 接受待处理任务。将任务从队列移至处理集合。
   * 仅目标 Bot（toBotId）可以接受。
   * @throws TaskNotFoundError 任务不存在
   * @throws UnauthorizedTaskError Bot 不是目标接收方
   * @throws TaskAlreadyAcceptedError 任务不在 pending 状态
   */
  accept(taskId: string, botId: string, executorSessionKey?: string): Promise<void>;

  /**
   * 将已接受的任务标记为处理中。
   * 仅目标 Bot 可以启动。
   */
  start(taskId: string, botId: string): Promise<void>;

  /**
   * 完成任务，附带结果或错误。
   * 通过消息总线通知发起方 Bot。
   */
  complete(taskId: string, req: TaskCompleteRequest, botId: string): Promise<void>;

  /**
   * 取消待处理或已接受的任务。
   * 仅发起方 Bot（fromBotId）可以取消。
   */
  cancel(taskId: string, reason: string, botId: string): Promise<void>;

  /**
   * 获取任务详情。仅发送方或接收方 Bot 可查看。
   * 未找到或无权限时返回 null。
   */
  getTask(taskId: string, botId: string): Promise<Task | null>;

  /**
   * 获取 Bot 的分页任务列表。
   */
  getTasksByBot(botId: string, options?: TaskQueryOptions): Promise<PaginatedResponse<Task>>;

  /**
   * 将已接受/处理中的任务重置为 pending 以便重新路由。
   * 递增 retryCount。用于子会话死亡时的恢复。
   * @throws InvalidTaskStateError 任务不在 accepted/processing 状态
   * @throws CoordinatorError 重试次数已耗尽
   */
  reset(taskId: string, botId: string): Promise<void>;

  /**
   * 重试失败或超时的任务，重新入队。
   */
  retry(taskId: string): Promise<void>;

  /**
   * 清理过期任务。返回清理的任务数量。
   */
  cleanupExpiredTasks(): Promise<number>;
}
```

### 3.3 IMessageBus

> 定义位置：`packages/api/src/message-bus/interface.ts`
> 职责：实时消息推送、Bot 状态同步、WebSocket 管理、Redis Pub/Sub 事件分发。
> 被 `TaskCoordinator`、`WorkflowEngine`、`Dashboard` 依赖。

#### 辅助类型

```typescript
/** Bot 状态类型，派生自 Bot 接口 */
type BotStatus = Bot['status'];  // 'online' | 'offline' | 'busy' | 'focus_mode'

/** 消息处理函数 */
type MessageHandler = (message: Message) => Promise<void>;

/** 客户端消息格式（client → server） */
interface ClientMessage {
  action: 'subscribe' | 'unsubscribe' | 'status_update' | 'ack';
  payload: unknown;
}

/** 服务端消息格式（server → client），扩展基础 Message 类型 */
interface ServerMessage<T = unknown> extends Message<T> {
  targetBotId?: string;
}

/** WebSocket 连接信息 */
interface ConnectionInfo {
  botId: string;
  connectedAt: Date;
  lastMessageAt?: Date;
  lastPingAt?: Date;
  lastPongAt?: Date;
}
```

#### 接口定义

```typescript
/**
 * 消息总线接口。
 * 真实实现基于 Redis Pub/Sub + WebSocket，Mock 实现使用内存事件发射器。
 */
interface IMessageBus {
  /**
   * 发布事件到消息总线。
   * 若指定 targetBotId，消息路由到特定 Bot；
   * 否则根据事件类型广播。
   */
  publish(event: MessageType, payload: unknown, targetBotId?: string): Promise<void>;

  /**
   * 订阅 Bot 接收消息。
   * handler 会在每条发送给该 Bot 的消息到达时被调用。
   */
  subscribe(botId: string, handler: MessageHandler): Promise<void>;

  /**
   * 取消 Bot 的消息订阅。
   */
  unsubscribe(botId: string): Promise<void>;

  /**
   * 更新 Bot 状态。
   * 触发 bot_status_changed 事件广播。
   */
  updateBotStatus(botId: string, status: BotStatus): Promise<void>;

  /**
   * 获取当前在线的 Bot ID 列表。
   */
  getOnlineBots(): Promise<string[]>;

  /**
   * 检查特定 Bot 是否在线。
   */
  isBotOnline(botId: string): Promise<boolean>;

  /**
   * 优雅关闭消息总线。
   */
  close(): Promise<void>;
}
```

#### Redis 频道常量

```typescript
const REDIS_CHANNELS = {
  TASK_ASSIGNED:      'clawteam:events:task_assigned',
  TASK_COMPLETED:     'clawteam:events:task_completed',
  TASK_FAILED:        'clawteam:events:task_failed',
  BOT_STATUS:         'clawteam:events:bot_status',
  WORKFLOW_STARTED:   'clawteam:events:workflow_started',
  WORKFLOW_COMPLETED: 'clawteam:events:workflow_completed',
  BROADCAST:          'clawteam:events:broadcast',
} as const;

const REDIS_KEYS = {
  OFFLINE_QUEUE:  (botId: string) => `clawteam:offline:${botId}`,
  MESSAGE_HISTORY:(botId: string) => `clawteam:messages:${botId}`,
  PENDING_ACK:    (messageId: string) => `clawteam:pending_ack:${messageId}`,
  DEAD_LETTER:    (botId: string) => `clawteam:dead_letter:${botId}`,
} as const;
```

#### Phase 2 功能配置类型

```typescript
/** 心跳检测配置 */
interface HeartbeatConfig {
  enabled: boolean;
  /** Ping 间隔（毫秒，默认 30000） */
  intervalMs: number;
  /** 超时时间（毫秒，超时后关闭连接，默认 10000） */
  timeoutMs: number;
}

/** 消息确认配置 */
interface AckConfig {
  enabled: boolean;
  /** 超时时间（毫秒，超时后触发重试，默认 30000） */
  timeoutMs: number;
  /** 需要 ACK 的消息类型 */
  requiredFor: MessageType[];
}

/** 离线消息队列配置 */
interface OfflineQueueConfig {
  enabled: boolean;
  /** 每个 Bot 的最大队列大小（默认 100） */
  maxQueueSize: number;
  /** 消息 TTL（秒，默认 86400） */
  messageTtlSeconds: number;
}

/** 消息持久化配置 */
interface PersistenceConfig {
  enabled: boolean;
  /** 存储消息的 TTL（秒，默认 604800 = 7 天） */
  ttlSeconds: number;
  /** 每个 Bot 最大存储消息数（默认 1000） */
  maxMessagesPerBot: number;
}

/** 重试机制配置 */
interface RetryConfig {
  enabled: boolean;
  /** 最大重试次数（默认 3） */
  maxRetries: number;
  /** 指数退避基础延迟（毫秒，默认 1000） */
  baseDelayMs: number;
  /** 最大延迟（毫秒，默认 30000） */
  maxDelayMs: number;
}

/** 消息总线功能配置（组合） */
interface MessageBusFeatureConfig {
  heartbeat?: HeartbeatConfig;
  ack?: AckConfig;
  offlineQueue?: OfflineQueueConfig;
  persistence?: PersistenceConfig;
  retry?: RetryConfig;
}
```

---

## 4. 路由层接口

> 路由层定义在 `packages/clawteam-gateway/src/` 下。
> ClawTeam Gateway 是一个独立进程，负责从平台 API 轮询任务并路由到 OpenClaw 会话。

### 4.1 路由决策类型

> 定义位置：`packages/clawteam-gateway/src/types.ts`

```typescript
/** 路由器决定对任务采取的动作 */
type RoutingAction = 'send_to_main' | 'send_to_session';

/** 纯路由决策 — 无 I/O，仅表达意图 */
interface RoutingDecision {
  taskId: string;
  action: RoutingAction;
  /** 目标会话 key（仅 send_to_session 时有值） */
  targetSessionKey?: string;
  task: Task;
  /** 人类可读的决策原因，用于日志 */
  reason: string;
}

/** 执行路由决策后的结果 */
interface RoutingResult {
  taskId: string;
  success: boolean;
  action: RoutingAction;
  /** 接收消息的会话 */
  sessionKey?: string;
  error?: string;
  /** 目标会话过期后是否回退到主会话 */
  fallback?: boolean;
}
```

### 4.2 API 响应类型

> 定义位置：`packages/clawteam-gateway/src/types.ts`
> 这些类型描述 ClawTeam Gateway 调用平台 API 和 OpenClaw API 时的响应格式。

```typescript
/** GET /api/v1/tasks/pending 响应 */
interface PollResponse {
  success: boolean;
  data?: {
    tasks: Task[];
    hasMore: boolean;
  };
  error?: {
    code: string;
    message: string;
  };
  traceId?: string;
}

/** GET /api/v1/tasks?status=...&role=to 响应 */
interface ActiveTasksResponse {
  success: boolean;
  data?: {
    items: Task[];
    total: number;
  };
  error?: {
    code: string;
    message: string;
  };
  traceId?: string;
}

/** GET /api/v1/tasks/:taskId 响应 */
interface TaskResponse {
  success: boolean;
  data?: Task;
  error?: {
    code: string;
    message: string;
  };
  traceId?: string;
}

/** OpenClaw 会话发送响应 */
interface SessionSendResponse {
  success: boolean;
  error?: string;
}

/** OpenClaw 会话状态检查响应 */
interface SessionStatusResponse {
  alive: boolean;
  sessionKey: string;
}
```

### 4.3 IClawTeamApiClient

> 定义位置：`packages/clawteam-gateway/src/clients/clawteam-api.ts`
> 职责：封装对 ClawTeam Platform API 的 HTTP 调用，使用 Bearer Token 认证。

```typescript
/**
 * ClawTeam 平台 API 客户端接口。
 * 使用 Node 18+ 原生 fetch，所有请求带 10s 超时。
 */
interface IClawTeamApiClient {
  /** 轮询待处理任务 */
  pollPendingTasks(limit?: number): Promise<Task[]>;

  /** 轮询活跃任务（pending/accepted/processing） */
  pollActiveTasks(limit?: number): Promise<Task[]>;

  /** 接受任务，可选传入执行方会话标识 */
  acceptTask(taskId: string, executorSessionKey?: string): Promise<void>;

  /** 将任务标记为处理中 */
  startTask(taskId: string): Promise<void>;

  /** 获取任务详情，未找到返回 null */
  getTask(taskId: string): Promise<Task | null>;

  /** 发送心跳报告 */
  sendHeartbeat(taskId: string, payload: HeartbeatPayload): Promise<void>;

  /** 将任务重置为 pending 状态，成功返回 true */
  resetTask(taskId: string): Promise<boolean>;
}
```

### 4.4 IOpenClawSessionClient

> 定义位置：`packages/clawteam-gateway/src/clients/openclaw-session.ts`
> 职责：与 OpenClaw 会话管理 API 通信。ClawTeam Gateway 仅发送消息到会话，不负责创建会话。

```typescript
/**
 * OpenClaw 会话客户端接口。
 * 支持 CLI 模式和 HTTP 模式两种通信方式。
 */
interface IOpenClawSessionClient {
  /** 向指定会话发送消息，成功返回 true */
  sendToSession(sessionKey: string, message: string): Promise<boolean>;

  /** 向主会话发送消息，成功返回 true */
  sendToMainSession(message: string): Promise<boolean>;

  /** 检查会话是否存活 */
  isSessionAlive(sessionKey: string): Promise<boolean>;

  /** 尝试恢复已归档/孤立的会话，恢复成功返回 true（可选实现） */
  restoreSession?(sessionKey: string): Promise<boolean>;

  /** 反向查找：根据原始会话 ID（UUID）查找会话 key（可选实现） */
  resolveSessionKeyFromId?(sessionId: string): string | undefined;
}
```

### 4.5 SessionTracker

> 定义位置：`packages/clawteam-gateway/src/routing/session-tracker.ts`
> 职责：内存中的双向映射，追踪哪个会话处理哪个任务。
> 设计为纯内存（非 Redis），因为 ClawTeam Gateway 是单进程，重启后通过重新轮询恢复状态。

```typescript
/**
 * 会话追踪器。
 * 维护 taskId ↔ sessionKey 的双向映射。
 */
class SessionTracker {
  /** taskId → sessionKey */
  private taskToSession: Map<string, string>;
  /** sessionKey → Set<taskId> */
  private sessionToTasks: Map<string, Set<string>>;

  /** 记录任务由某个会话处理 */
  track(taskId: string, sessionKey: string): void;

  /** 检查任务是否正在被追踪 */
  isTracked(taskId: string): boolean;

  /** 查找处理指定任务的会话 */
  getSessionForTask(taskId: string): string | undefined;

  /** 获取指定会话的所有任务 */
  getTasksForSession(sessionKey: string): string[];

  /** 移除已完成/已取消任务的追踪 */
  untrack(taskId: string): void;

  /** 获取所有追踪的 task→session 对 */
  getAllTracked(): Array<{ taskId: string; sessionKey: string }>;

  /** 获取健康监控统计 */
  getStats(): { trackedTasks: number; activeSessions: number };
}
```

### 4.6 TaskRouter 核心类

> 定义位置：`packages/clawteam-gateway/src/routing/router.ts`
> 两阶段设计：`decide()` 纯逻辑无 I/O → `execute()` 执行 I/O。

```typescript
/** TaskRouter 构造函数依赖 */
interface TaskRouterDeps {
  clawteamApi: IClawTeamApiClient;
  openclawSession: IOpenClawSessionClient;
  sessionTracker: SessionTracker;
  clawteamApiUrl: string;
  logger: Logger;
}

/**
 * 核心任务路由器，继承 EventEmitter。
 *
 * 路由规则：
 * - type=new（或未定义）：发送到主会话（主会话负责创建子会话）
 * - type=sub-task 且有 targetSessionKey：发送到目标会话
 * - type=sub-task 无 targetSessionKey：回退到主会话
 * - 目标会话过期：尝试恢复，失败则回退到主会话并附带父任务上下文
 */
class TaskRouter extends EventEmitter {
  constructor(deps: TaskRouterDeps);

  /** 阶段 1：决定路由目标（纯逻辑，无 I/O） */
  decide(task: Task): RoutingDecision;

  /** 阶段 2：执行路由决策（执行 I/O） */
  execute(decision: RoutingDecision): Promise<RoutingResult>;

  /** 便捷方法：decide + execute 一步完成 */
  route(task: Task): Promise<RoutingResult>;
}
```

### 4.7 TaskRouterConfig

> 定义位置：`packages/clawteam-gateway/src/config.ts`
> 配置优先级：环境变量 > `~/.clawteam/config.yaml` > 代码默认值。

```typescript
type OpenClawMode = 'cli' | 'http';

interface TaskRouterConfig {
  /** ClawTeam API 基础 URL */
  clawteamApiUrl: string;
  /** ClawTeam API Key */
  clawteamApiKey: string;
  /** OpenClaw 通信模式：'cli'（默认）或 'http' */
  openclawMode: OpenClawMode;
  /** OpenClaw API 基础 URL（仅 http 模式） */
  openclawApiUrl: string;
  /** OpenClaw API Key（可选，仅 http 模式） */
  openclawApiKey?: string;
  /** openclaw 二进制路径（仅 cli 模式） */
  openclawBin: string;
  /** 轮询间隔（毫秒） */
  pollIntervalMs: number;
  /** 每次轮询最大任务数 */
  pollLimit: number;
  /** 主 Agent 标识符（如 "main", "bob"） */
  mainAgentId: string;
  /** 会话存活阈值（毫秒，超过视为死亡） */
  sessionAliveThresholdMs: number;
  /** OpenClaw 主目录（默认 ~/.openclaw） */
  openclawHome: string;
  /** 日志级别 */
  logLevel: string;
  /** 心跳间隔（毫秒，默认 30000） */
  heartbeatIntervalMs: number;
  /** 是否启用心跳报告（默认 true） */
  heartbeatEnabled: boolean;
  /** 是否启用过期任务恢复（默认 true） */
  recoveryEnabled: boolean;
  /** 恢复检查间隔（毫秒，默认 120000） */
  recoveryIntervalMs: number;
  /** 会话空闲多久视为过期（毫秒，默认 300000） */
  stalenessThresholdMs: number;
  /** 每个任务最大恢复尝试次数（默认 3） */
  maxRecoveryAttempts: number;
  /** tool_calling 状态卡住多久视为死亡（毫秒，默认 600000） */
  toolCallingTimeoutMs: number;
  /** 是否启用本地 Router API 服务器（默认 false） */
  routerApiEnabled: boolean;
  /** 本地 Router API 端口（默认 3100） */
  routerApiPort: number;
  /** 日志文件目录（默认 'logs/'） */
  logDir: string;
}
```

---

## 5. 监控类型

> 定义位置：`packages/clawteam-gateway/src/monitoring/types.ts`
> 用于监控 OpenClaw 会话健康状态、JSONL 日志分析和心跳上报。

### 5.1 SessionState

会话状态枚举，通过 CLI 和 JSONL 分析推导得出。

```typescript
type SessionState =
  | 'active'        // LLM 正在生成（lastRole=toolResult，工具结果已返回，LLM 处理中）
  | 'tool_calling'  // 等待工具执行（lastRole=assistant, stopReason=toolUse）
  | 'waiting'       // 等待 LLM 响应（lastRole=user）
  | 'idle'          // 存活但无近期活动 / 无法确定具体状态
  | 'errored'       // 会话遇到错误（stopReason=error）
  | 'completed'     // 会话已完成（stopReason=stop）
  | 'dead'          // 会话未找到或已过期
  | 'unknown';      // 分析失败或无数据
```

### 5.2 JsonlAnalysis

JSONL 文件尾部分析结果。

```typescript
interface JsonlAnalysis {
  /** 最后一条消息的角色：user / assistant / toolResult */
  lastMessageRole: 'user' | 'assistant' | 'toolResult' | null;
  /** 最后一条 assistant 消息的停止原因 */
  lastStopReason: 'stop' | 'toolUse' | 'error' | null;
  /** 错误文本（stopReason=error 时） */
  lastErrorMessage: string | null;
  /** 分析尾部中 tool_use 内容块的数量 */
  toolCallCount: number;
  /** 分析尾部的总消息数 */
  messageCount: number;
  /** 最后一条 assistant 消息的模型标识 */
  model: string | null;
  /** 最后一条 assistant 消息的提供商 */
  provider: string | null;
}
```

### 5.3 TaskSessionStatus

任务关联会话的综合状态。

```typescript
interface TaskSessionStatus {
  taskId: string;
  sessionKey: string;
  sessionState: SessionState;
  lastActivityAt: Date | null;
  details: SessionStatusDetails;
}
```

### 5.4 SessionStatusDetails

会话状态详细信息。

```typescript
interface SessionStatusDetails {
  /** 会话进程是否存活（来自 CLI） */
  alive: boolean;
  /** JSONL 分析结果（文件未找到或分析失败时为 null） */
  jsonlAnalysis: JsonlAnalysis | null;
  /** 会话存活时长（毫秒，来自 CLI） */
  ageMs: number | null;
  /** 从 session key 解析的 Agent ID */
  agentId: string | null;
  /** 真实会话 UUID */
  sessionId: string | null;
}
```

### 5.5 HeartbeatPayload

发送到平台 API 心跳端点的负载。

```typescript
interface HeartbeatPayload {
  sessionKey: string;
  sessionStatus: SessionState;
  lastActivityAt: string | null;
  details: SessionStatusDetails;
}
```

### 5.6 CliSessionInfo

从 `openclaw sessions --json` 获取的 CLI 会话信息。

```typescript
interface CliSessionInfo {
  key: string;
  sessionId?: string;
  ageMs?: number;
  updatedAt?: number;
  alive: boolean;
}
```

---

## 6. 服务器类型

> 定义位置：`packages/clawteam-gateway/src/server/types.ts`
> ClawTeam Gateway 本地 HTTP + WebSocket API 的请求/响应类型，供客户端消费。

### 6.1 HTTP 响应类型

```typescript
/** GET /status 响应 — 路由器运行状态 */
interface RouterStatusResponse {
  uptime: number;
  trackedTasks: number;
  activeSessions: number;
  pollerRunning: boolean;
  heartbeatRunning: boolean;
  pollIntervalMs: number;
}

/** GET /sessions 响应 — 所有会话状态 */
interface SessionListResponse {
  sessions: TaskSessionStatus[];
}

/** GET /tasks 响应 — 所有追踪中的任务 */
interface TrackedTasksResponse {
  tasks: Array<{ taskId: string; sessionKey: string }>;
}

/** GET /routes/history 响应 — 路由历史 */
interface RouteHistoryResponse {
  entries: RouteHistoryEntry[];
}
```

### 6.2 RouteHistoryEntry

单条路由历史记录。

```typescript
interface RouteHistoryEntry {
  timestamp: number;
  taskId: string;
  action: RoutingAction;
  sessionKey?: string;
  success: boolean;
  reason: string;
  fallback?: boolean;
  error?: string;
}
```

### 6.3 WebSocket 事件类型

ClawTeam Gateway 通过 WebSocket 推送以下三种实时事件：

```typescript
/** 任务路由完成事件 */
interface TaskRoutedEvent {
  type: 'task_routed';
  taskId: string;
  action: RoutingAction;
  sessionKey?: string;
  success: boolean;
  reason: string;
}

/** 会话状态变更事件 */
interface SessionStateChangedEvent {
  type: 'session_state_changed';
  taskId: string;
  sessionKey: string;
  state: SessionState;
  details: TaskSessionStatus['details'];
}

/** 轮询完成事件 */
interface PollCompleteEvent {
  type: 'poll_complete';
  fetched: number;
  routed: number;
  failed: number;
  skipped: number;
}

/** WebSocket 事件联合类型 */
type RouterWsEvent =
  | TaskRoutedEvent
  | SessionStateChangedEvent
  | PollCompleteEvent;
```

---

## 7. 接口依赖图

### 7.1 模块依赖关系

```
@clawteam/shared/types          ← 所有模块的类型基础
        │
        ├──→ packages/api/src/capability-registry/
        │      定义: ICapabilityRegistry, BotRegisterRequest/Response
        │      消费: Bot, BotCapability, CapabilitySearchQuery, CapabilityMatch, PaginatedResponse
        │
        ├──→ packages/api/src/message-bus/
        │      定义: IMessageBus, MessageHandler, ClientMessage, ServerMessage, ConnectionInfo
        │      消费: Message, MessageType, Bot
        │
        ├──→ packages/api/src/task-coordinator/
        │      定义: ITaskCoordinator, TaskQueryOptions, TaskDelegateResponse
        │      消费: Task, TaskStatus, TaskDelegateRequest, TaskCompleteRequest, PaginatedResponse
        │      依赖: ICapabilityRegistry, IMessageBus
        │
        └──→ packages/clawteam-gateway/src/
               定义: RoutingDecision, RoutingResult, IClawTeamApiClient, IOpenClawSessionClient
               消费: Task, TaskType
               依赖: 通过 HTTP 调用 ITaskCoordinator 暴露的 API
```

### 7.2 接口定义与消费矩阵

| 接口/类型 | 定义模块 | 消费模块 |
|---|---|---|
| `Bot`, `Task`, `Message` 等共享类型 | `shared/types` | 所有模块 |
| `ICapabilityRegistry` | `api/capability-registry` | `api/task-coordinator`, `api/permission-manager` |
| `IMessageBus` | `api/message-bus` | `api/task-coordinator`, `api/workflow-engine`, `dashboard` |
| `ITaskCoordinator` | `api/task-coordinator` | `api/workflow-engine`, `clawteam-gateway`（通过 HTTP） |
| `IClawTeamApiClient` | `clawteam-gateway/clients` | `clawteam-gateway/routing`, `clawteam-gateway/monitoring` |
| `IOpenClawSessionClient` | `clawteam-gateway/clients` | `clawteam-gateway/routing` |
| `SessionTracker` | `clawteam-gateway/routing` | `clawteam-gateway/routing`, `clawteam-gateway/server` |
| 监控类型（`SessionState` 等） | `clawteam-gateway/monitoring` | `clawteam-gateway/clients`, `clawteam-gateway/server` |
| 服务器类型（`RouterWsEvent` 等） | `clawteam-gateway/server` | WebSocket 客户端、Dashboard |

### 7.3 数据流向

```
Bot (OpenClaw)
  │
  │  HTTP (Bearer Token)
  ▼
┌─────────────────────────────────────────────┐
│  ClawTeam Platform API (Fastify)            │
│                                             │
│  ICapabilityRegistry ──→ ITaskCoordinator   │
│         │                      │            │
│         └──── IMessageBus ─────┘            │
│                   │                         │
│              Redis Pub/Sub                  │
│                   │                         │
│              WebSocket Push                 │
└─────────────────────────────────────────────┘
                    │
                    │  HTTP (轮询 + 心跳)
                    ▼
┌─────────────────────────────────────────────┐
│  ClawTeam Gateway (独立进程)                  │
│                                             │
│  IClawTeamApiClient ──→ TaskRouter          │
│                            │                │
│  IOpenClawSessionClient ←──┘                │
│         │                                   │
│    SessionTracker                           │
│         │                                   │
│    Local API (HTTP + WebSocket)             │
└─────────────────────────────────────────────┘
                    │
                    │  CLI / HTTP
                    ▼
            OpenClaw Sessions
```

---

> 本文档基于源码自动生成，最后更新时间与代码库同步。
> 如有接口变更，请同步更新本文档。
