// Bot types
export interface BotCapability {
  name: string;
  description: string;
  async: boolean;
  estimatedTime?: string;
}

export interface Bot {
  id: string;
  name: string;
  ownerEmail?: string;
  teamId?: string;
  status: 'online' | 'offline' | 'busy' | 'focus_mode';
  capabilities: BotCapability[];
  tags?: string[];
  createdAt: string;
  lastSeen?: string;
  metadata?: Record<string, unknown>;
  avatarColor?: string;
  avatarUrl?: string;
}

// Task types
export type TaskStatus = 'pending' | 'accepted' | 'processing' | 'waiting_for_input' | 'pending_review' | 'completed' | 'failed' | 'timeout' | 'cancelled';
export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low';
export type TaskType = 'new' | 'sub-task';

export interface Task {
  id: string;
  fromBotId: string;
  fromBotName?: string;
  fromAvatarColor?: string;
  fromAvatarUrl?: string;
  toBotId: string;
  toBotName?: string;
  toAvatarColor?: string;
  toAvatarUrl?: string;
  prompt?: string;
  capability?: string;
  parameters?: Record<string, unknown>;
  priority: TaskPriority;
  status: TaskStatus;
  type?: TaskType;
  title?: string;
  parentTaskId?: string;
  senderSessionKey?: string;
  executorSessionKey?: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  timeoutAt?: string;
  submittedResult?: unknown;
  submittedAt?: string;
  rejectionReason?: string;
}

// Message types
export type MessageType = 'direct_message' | 'task_notification' | 'delegate_intent' | 'broadcast' | 'system' | 'human_input_request' | 'human_input_response' | 'task_continuation';
export type MessageStatus = 'delivered' | 'read';

export interface Message {
  messageId: string;
  fromBotId: string;
  toBotId: string;
  type: MessageType;
  contentType: string;
  content: any;
  priority: TaskPriority;
  status: MessageStatus;
  taskId: string | null;
  traceId: string;
  createdAt: string;
  readAt: string | null;
  fromBotName?: string;
  fromAvatarColor?: string;
  fromAvatarUrl?: string;
  toBotName?: string;
  toAvatarColor?: string;
  toAvatarUrl?: string;
}

// WebSocket message types
export interface WSMessage {
  type: string;
  payload: unknown;
}

export interface TaskAssignedMessage extends WSMessage {
  type: 'task_assigned';
  payload: Task;
}

export interface TaskCompletedMessage extends WSMessage {
  type: 'task_completed';
  payload: Task;
}

export interface BotStatusMessage extends WSMessage {
  type: 'bot_status_changed';
  payload: {
    botId: string;
    status: 'online' | 'offline';
  };
}

// Router API types
export type RoutingAction = 'send_to_main' | 'send_to_session';

export type SessionState =
  | 'active'
  | 'tool_calling'
  | 'waiting'
  | 'idle'
  | 'errored'
  | 'completed'
  | 'dead'
  | 'unknown';

export interface RouterStatus {
  uptime: number;
  trackedTasks: number;
  activeSessions: number;
  pollerRunning: boolean;
  heartbeatRunning: boolean;
  pollIntervalMs: number;
}

export interface SessionStatusDetails {
  alive: boolean;
  jsonlAnalysis: {
    lastMessageRole: 'user' | 'assistant' | 'toolResult' | null;
    lastStopReason: 'stop' | 'toolUse' | 'error' | null;
    lastErrorMessage: string | null;
    toolCallCount: number;
    messageCount: number;
    model: string | null;
    provider: string | null;
  } | null;
  ageMs: number | null;
  agentId: string | null;
  sessionId: string | null;
}

export interface SessionStatus {
  taskId: string;
  sessionKey: string;
  sessionState: SessionState;
  lastActivityAt: string | null;
  details: SessionStatusDetails;
}

export interface RouteHistoryEntry {
  timestamp: number;
  taskId: string;
  action: RoutingAction;
  sessionKey?: string;
  success: boolean;
  reason: string;
  fallback?: boolean;
  error?: string;
}

export interface TrackedTask {
  taskId: string;
  sessionKey: string;
}

// File service types
export type FileScope = 'bot_private' | 'task' | 'team_shared';
export type FileKind = 'folder' | 'file' | 'doc';

export interface FileNode {
  id: string;
  teamId: string;
  parentId: string | null;
  scope: FileScope;
  scopeRef: string | null;
  kind: FileKind;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  storageKey: string | null;
  metadata: Record<string, unknown>;
  createdByActorType: 'bot' | 'user' | 'system';
  createdByActorId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// Router WebSocket event types
export interface TaskRoutedEvent {
  type: 'task_routed';
  taskId: string;
  action: RoutingAction;
  sessionKey?: string;
  success: boolean;
  reason: string;
}

export interface SessionStateChangedEvent {
  type: 'session_state_changed';
  taskId: string;
  sessionKey: string;
  state: SessionState;
  details: SessionStatusDetails;
}

export interface PollCompleteEvent {
  type: 'poll_complete';
  fetched: number;
  routed: number;
  failed: number;
  skipped: number;
}

export type RouterWsEvent =
  | TaskRoutedEvent
  | SessionStateChangedEvent
  | PollCompleteEvent;

// Timeline types
export type TimelineEntry =
  | { kind: 'task'; createdAt: string; data: Task }
  | { kind: 'message'; createdAt: string; data: Message };
