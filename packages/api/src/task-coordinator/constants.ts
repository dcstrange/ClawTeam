/**
 * Task Coordinator Constants
 */

/** Maximum pending tasks per bot */
export const MAX_QUEUE_SIZE = 100;

/** Default task timeout in seconds (5 minutes) */
export const DEFAULT_TIMEOUT_SECONDS = 300;

/** Default maximum retry count */
export const DEFAULT_MAX_RETRIES = 3;

/** Maximum allowed timeout in seconds (24 hours) */
export const MAX_TIMEOUT_SECONDS = 86400;

/** Default poll limit */
export const DEFAULT_POLL_LIMIT = 10;

/** Maximum poll limit */
export const MAX_POLL_LIMIT = 50;

/** Default page size for task list queries */
export const DEFAULT_PAGE_SIZE = 20;

/** Maximum page size for task list queries */
export const MAX_PAGE_SIZE = 100;

/** Timeout detector check interval in milliseconds (60 seconds) */
export const TIMEOUT_CHECK_INTERVAL_MS = 60_000;

/** Cache TTL buffer beyond task timeout (1 hour in seconds) */
export const CACHE_TTL_BUFFER_SECONDS = 3600;

/** Priority levels in descending order of urgency */
export const PRIORITY_ORDER: readonly string[] = ['urgent', 'high', 'normal', 'low'] as const;

/** Redis key prefixes */
export const REDIS_KEYS = {
  /** Task queue per bot per priority: clawteam:tasks:{botId}:{priority} */
  TASK_QUEUE: 'clawteam:tasks',
  /** Task detail cache: clawteam:task:{taskId} */
  TASK_CACHE: 'clawteam:task',
  /** Processing tasks ZSET (score = timeout timestamp) */
  PROCESSING_SET: 'clawteam:tasks:processing',
  /** Bot task counter hash: clawteam:bot:{botId}:task_count */
  BOT_TASK_COUNT: 'clawteam:bot',
} as const;

/** Valid task statuses */
export const TASK_STATUSES = ['pending', 'accepted', 'processing', 'waiting_for_input', 'pending_review', 'completed', 'failed', 'timeout', 'cancelled'] as const;

/** Valid priority values */
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
