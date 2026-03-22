/**
 * Task Coordinator Internal Types
 */

import type { Task, TaskStatus, TaskPriority, TaskType } from '@clawteam/shared/types';

/**
 * Database row representation (snake_case columns)
 */
export interface TaskRow {
  id: string;
  from_bot_id: string;
  to_bot_id: string;
  prompt: string | null;
  capability: string | null;
  parameters: Record<string, any>;
  status: TaskStatus;
  priority: TaskPriority;
  type: TaskType | null;
  title: string | null;
  parent_task_id: string | null;
  sender_session_key: string | null;
  executor_session_key: string | null;
  result: any | null;
  error: { code: string; message: string; details?: any } | null;
  timeout_seconds: number;
  retry_count: number;
  max_retries: number;
  created_at: Date;
  accepted_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  human_context: string | null;
  conversation_id: string | null;
  workflow_id: string | null;
  metadata: Record<string, any> | null;
  submitted_result: any | null;
  submitted_at: Date | null;
  rejection_reason: string | null;
}

/**
 * Input for creating a task record in the database
 */
export interface TaskCreateInput {
  id: string;
  fromBotId: string;
  toBotId: string;
  capability: string;
  parameters: Record<string, any>;
  priority: TaskPriority;
  type?: TaskType;
  parentTaskId?: string;
  senderSessionKey?: string;
  timeoutSeconds: number;
  maxRetries: number;
  humanContext?: string;
  conversationId?: string;
  workflowId?: string;
  metadata?: Record<string, any>;
}

/**
 * Convert a database row to a Task domain object
 */
export function taskRowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    fromBotId: row.from_bot_id,
    toBotId: row.to_bot_id,
    prompt: row.prompt ?? undefined,
    capability: row.capability ?? 'general',
    parameters: row.parameters,
    status: row.status,
    priority: row.priority,
    type: row.type ?? undefined,
    title: row.title ?? undefined,
    parentTaskId: row.parent_task_id ?? undefined,
    senderSessionKey: row.sender_session_key ?? undefined,
    executorSessionKey: row.executor_session_key ?? undefined,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    timeoutSeconds: row.timeout_seconds,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    createdAt: row.created_at.toISOString(),
    acceptedAt: row.accepted_at?.toISOString(),
    startedAt: row.started_at?.toISOString(),
    completedAt: row.completed_at?.toISOString(),
    humanContext: row.human_context ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    workflowId: row.workflow_id ?? undefined,
    submittedResult: row.submitted_result ?? undefined,
    submittedAt: row.submitted_at?.toISOString(),
    rejectionReason: row.rejection_reason ?? undefined,
  };
}
