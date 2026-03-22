/**
 * ClawTeam Platform - Shared Types
 * 所有模块共享的类型定义
 */

// Re-export primitive types
export * from './primitives';

// ============================================================================
// Bot 相关类型
// ============================================================================

export interface BotCapability {
  /** 能力名称，如 "code_search", "run_tests" */
  name: string;
  /** 能力描述 */
  description: string;
  /** 是否异步执行 */
  async: boolean;
  /** 预估执行时间，如 "5s", "2m" */
  estimatedTime: string;
}

export interface BotAvailability {
  /** 时区，如 "UTC-8" */
  timezone: string;
  /** 工作时间，如 "09:00-18:00" */
  workingHours: string;
  /** 离线时是否自动响应 */
  autoRespond: boolean;
}

export interface Bot {
  /** Bot 唯一标识 */
  id: string;
  /** 所属团队 */
  teamId: string;
  /** Bot 名称 */
  name: string;
  /** 所有者邮箱（可选，用户级 key 后不再必需） */
  ownerEmail?: string;
  /** API Key 哈希（deprecated，用户级 key 在 users 表） */
  apiKeyHash?: string;
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
  /** 头像颜色（hex，如 #3b82f6） */
  avatarColor?: string;
  /** 头像图片 URL（可选） */
  avatarUrl?: string;
}

// ============================================================================
// Task 相关类型
// ============================================================================

export type TaskStatus = 'pending' | 'accepted' | 'processing' | 'waiting_for_input' | 'pending_review' | 'completed' | 'failed' | 'timeout' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskType = 'new' | 'sub-task';

export interface Task {
  /** 任务唯一标识 */
  id: string;
  /** 发起 Bot */
  fromBotId: string;
  /** 目标 Bot */
  toBotId: string;
  /** 自然语言任务描述 */
  prompt?: string;
  /** 调用的能力（可选路由提示） */
  capability?: string;
  /** 参数（可选结构化附件） */
  parameters?: Record<string, any>;
  /** 任务状态 */
  status: TaskStatus;
  /** 优先级 */
  priority: TaskPriority;
  /** 任务类型 (new=新任务, sub-task=子任务) */
  type?: TaskType;
  /** 可选标题，缺省 fallback 到 capability */
  title?: string;
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
  /** 执行者提交的结果（pending_review 阶段） */
  submittedResult?: any;
  /** 提交时间 */
  submittedAt?: string;
  /** 拒绝原因 */
  rejectionReason?: string;
}

export interface TaskDelegateRequest {
  /** 目标 Bot */
  toBotId: string;
  /** 自然语言任务描述（必填） */
  prompt: string;
  /** 调用的能力（可选路由提示） */
  capability?: string;
  /** 参数（可选结构化附件） */
  parameters?: Record<string, any>;
  /** 优先级 */
  priority?: TaskPriority;
  /** 任务类型 */
  type?: TaskType;
  /** 可选标题 */
  title?: string;
  /** 父任务 ID (用于 sub-task) */
  parentTaskId?: string;
  /** 委托方的会话标识 */
  senderSessionKey?: string;
  /** 超时时间（秒） */
  timeoutSeconds?: number;
  /** 人类上下文 */
  humanContext?: string;
}

export interface TaskCreateRequest {
  /** 任务描述 */
  prompt: string;
  /** 可选标题 */
  title?: string;
  /** 能力标签 */
  capability?: string;
  /** 结构化参数 */
  parameters?: Record<string, any>;
  /** 优先级 */
  priority?: TaskPriority;
  /** 任务类型 */
  type?: TaskType;
  /** 父任务 ID */
  parentTaskId?: string;
  /** 人类上下文 */
  humanContext?: string;
  /** 超时时间（秒） */
  timeoutSeconds?: number;
}

export interface TaskCompleteRequest {
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
}

// ============================================================================
// Workflow 相关类型
// ============================================================================

export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowStep {
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

export interface WorkflowDefinition {
  /** 工作流名称 */
  name: string;
  /** 描述 */
  description?: string;
  /** 步骤列表 */
  steps: WorkflowStep[];
}

export interface Workflow {
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

export interface WorkflowExecuteRequest {
  /** 工作流名称或定义 */
  workflow: string | WorkflowDefinition;
  /** 参数 */
  parameters?: Record<string, any>;
}

// ============================================================================
// Permission 相关类型
// ============================================================================

export interface BotPermission {
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

export interface AuditLog {
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

// ============================================================================
// Message Bus 相关类型
// ============================================================================

export type MessageType =
  | 'task_assigned'
  | 'task_completed'
  | 'task_failed'
  | 'task_continued'
  | 'task_pending_review'
  | 'task_rejected'
  | 'bot_status_changed'
  | 'workflow_started'
  | 'workflow_completed';

export interface Message<T = any> {
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

export interface BotStatusMessage {
  botId: string;
  status: Bot['status'];
  timestamp: string;
}

export interface TaskMessage {
  taskId: string;
  fromBotId: string;
  toBotId: string;
  capability: string;
}

// ============================================================================
// API 响应类型
// ============================================================================

export interface ApiResponse<T = any> {
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

export interface PaginatedResponse<T> {
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

// ============================================================================
// Capability Search 相关类型
// ============================================================================

export interface CapabilitySearchQuery {
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

export interface CapabilityMatch {
  /** Bot ID */
  botId: string;
  /** Bot 名称 */
  botName: string;
  /** 所有者 */
  ownerEmail?: string;
  /** 匹配的能力 */
  capability: BotCapability;
  /** 匹配度（0-1） */
  confidence: number;
  /** 最后更新时间 */
  lastModified: string;
}

// ============================================================================
// Team 相关类型
// ============================================================================

export interface Team {
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

export interface TeamInviteCode {
  /** 邀请码 */
  code: string;
  /** 所属团队 */
  teamId: string;
  /** 过期时间 */
  expiresAt: string;
  /** 是否已使用 */
  used: boolean;
}
