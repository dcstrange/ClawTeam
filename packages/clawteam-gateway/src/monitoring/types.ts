/**
 * Session Status Monitoring Types
 *
 * Types for monitoring OpenClaw session health, JSONL analysis,
 * and heartbeat reporting.
 */

/** Derived session state from CLI + JSONL analysis */
export type SessionState =
  | 'active'        // LLM generating (lastRole=toolResult — tool result returned, LLM processing)
  | 'tool_calling'  // Waiting for tool execution (lastRole=assistant, stopReason=toolUse)
  | 'waiting'       // Waiting for LLM response (lastRole=user)
  | 'idle'          // Alive but no recent activity / unable to determine specific state
  | 'errored'       // Session encountered an error (stopReason=error)
  | 'completed'     // Session completed (stopReason=stop)
  | 'dead'          // Session not found or expired
  | 'unknown';      // Analysis failed or no data

/** Result of analyzing a JSONL file tail */
export interface JsonlAnalysis {
  /** Role of the last message: user / assistant / toolResult */
  lastMessageRole: 'user' | 'assistant' | 'toolResult' | null;
  /** Stop reason from the last assistant message */
  lastStopReason: 'stop' | 'toolUse' | 'error' | null;
  /** Error text if stopReason=error */
  lastErrorMessage: string | null;
  /** Count of tool_use content blocks in analyzed tail */
  toolCallCount: number;
  /** Total message count in analyzed tail */
  messageCount: number;
  /** Model identifier from the last assistant message */
  model: string | null;
  /** Provider from the last assistant message */
  provider: string | null;
}

/** Combined status for a task's session */
export interface TaskSessionStatus {
  taskId: string;
  sessionKey: string;
  sessionState: SessionState;
  lastActivityAt: Date | null;
  details: SessionStatusDetails;
}

/** Detailed session status information */
export interface SessionStatusDetails {
  /** Whether the session process is alive (from CLI) */
  alive: boolean;
  /** JSONL analysis results (null if file not found or analysis failed) */
  jsonlAnalysis: JsonlAnalysis | null;
  /** Session age in ms (from CLI) */
  ageMs: number | null;
  /** Agent ID parsed from session key */
  agentId: string | null;
  /** Real session UUID */
  sessionId: string | null;
}

/** Payload sent to the API heartbeat endpoint */
export interface HeartbeatPayload {
  sessionKey: string;
  sessionStatus: SessionState;
  lastActivityAt: string | null;
  details: SessionStatusDetails;
}

/**
 * CLI session info from `openclaw sessions --json`.
 * OpenClaw-specific — used by SessionStatusResolver and cli-status.ts.
 * Future cleanup: may migrate to providers/openclaw/types.ts.
 */
export interface CliSessionInfo {
  key: string;
  sessionId?: string;
  ageMs?: number;
  updatedAt?: number;
  alive: boolean;
}
