/**
 * Message Bus Interface Definitions
 */

import type { Message, MessageType, Bot } from '@clawteam/shared/types';

/** Bot status type derived from Bot interface */
export type BotStatus = Bot['status'];

/** Handler function for processing messages */
export type MessageHandler = (message: Message) => Promise<void>;

/**
 * Core Message Bus interface.
 * Both real and mock implementations satisfy this contract.
 */
export interface IMessageBus {
  /**
   * Publish an event to the message bus.
   * If targetBotId is specified, the message is routed to that specific bot.
   * Otherwise, it's broadcast based on the event type.
   */
  publish(event: MessageType, payload: unknown, targetBotId?: string): Promise<void>;

  /**
   * Subscribe a bot to receive messages.
   * The handler will be called for each message addressed to this bot.
   */
  subscribe(botId: string, handler: MessageHandler): Promise<void>;

  /**
   * Unsubscribe a bot from receiving messages.
   */
  unsubscribe(botId: string): Promise<void>;

  /**
   * Update a bot's status.
   * This will trigger a bot_status_changed event broadcast.
   */
  updateBotStatus(botId: string, status: BotStatus): Promise<void>;

  /**
   * Get list of currently online bot IDs.
   */
  getOnlineBots(): Promise<string[]>;

  /**
   * Check if a specific bot is online.
   */
  isBotOnline(botId: string): Promise<boolean>;

  /**
   * Gracefully shutdown the message bus.
   */
  close(): Promise<void>;
}

/** Redis channel names for Pub/Sub */
export const REDIS_CHANNELS = {
  TASK_ASSIGNED: 'clawteam:events:task_assigned',
  TASK_COMPLETED: 'clawteam:events:task_completed',
  TASK_FAILED: 'clawteam:events:task_failed',
  TASK_CONTINUED: 'clawteam:events:task_continued',
  TASK_PENDING_REVIEW: 'clawteam:events:task_pending_review',
  TASK_REJECTED: 'clawteam:events:task_rejected',
  BOT_STATUS: 'clawteam:events:bot_status',
  WORKFLOW_STARTED: 'clawteam:events:workflow_started',
  WORKFLOW_COMPLETED: 'clawteam:events:workflow_completed',
  BROADCAST: 'clawteam:events:broadcast',
} as const;

/** Map MessageType to Redis channel */
export function getChannelForEvent(event: MessageType): string {
  const mapping: Record<MessageType, string> = {
    task_assigned: REDIS_CHANNELS.TASK_ASSIGNED,
    task_completed: REDIS_CHANNELS.TASK_COMPLETED,
    task_failed: REDIS_CHANNELS.TASK_FAILED,
    task_continued: REDIS_CHANNELS.TASK_CONTINUED,
    task_pending_review: REDIS_CHANNELS.TASK_PENDING_REVIEW,
    task_rejected: REDIS_CHANNELS.TASK_REJECTED,
    bot_status_changed: REDIS_CHANNELS.BOT_STATUS,
    workflow_started: REDIS_CHANNELS.WORKFLOW_STARTED,
    workflow_completed: REDIS_CHANNELS.WORKFLOW_COMPLETED,
  };
  return mapping[event];
}

/** All Redis channels to subscribe to */
export function getAllChannels(): string[] {
  return Object.values(REDIS_CHANNELS);
}

/**
 * Client message format (client → server)
 */
export interface ClientMessage {
  action: 'subscribe' | 'unsubscribe' | 'status_update' | 'ack';
  payload: unknown;
}

/**
 * Server message format (server → client)
 * This extends the base Message type with optional routing info.
 */
export interface ServerMessage<T = unknown> extends Message<T> {
  targetBotId?: string;
}

/**
 * WebSocket connection info stored per connection
 */
export interface ConnectionInfo {
  botId: string;
  connectedAt: Date;
  lastMessageAt?: Date;
  lastPingAt?: Date;
  lastPongAt?: Date;
}

// ============================================================================
// Phase 2: Feature Configuration
// ============================================================================

/** Heartbeat detection configuration */
export interface HeartbeatConfig {
  enabled: boolean;
  /** Ping interval in milliseconds (default: 30000) */
  intervalMs: number;
  /** Timeout in milliseconds before closing connection (default: 10000) */
  timeoutMs: number;
}

/** Message acknowledgment configuration */
export interface AckConfig {
  enabled: boolean;
  /** Timeout in milliseconds before triggering retry (default: 30000) */
  timeoutMs: number;
  /** Message types that require ACK */
  requiredFor: MessageType[];
}

/** Offline message queue configuration */
export interface OfflineQueueConfig {
  enabled: boolean;
  /** Maximum queue size per bot (default: 100) */
  maxQueueSize: number;
  /** Message TTL in seconds (default: 86400) */
  messageTtlSeconds: number;
}

/** Message persistence configuration */
export interface PersistenceConfig {
  enabled: boolean;
  /** TTL for stored messages in seconds (default: 604800 = 7 days) */
  ttlSeconds: number;
  /** Maximum messages to store per bot (default: 1000) */
  maxMessagesPerBot: number;
}

/** Retry mechanism configuration */
export interface RetryConfig {
  enabled: boolean;
  /** Maximum retry attempts (default: 3) */
  maxRetries: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000) */
  baseDelayMs: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs: number;
}

/** Combined feature configuration for MessageBus */
export interface MessageBusFeatureConfig {
  heartbeat?: HeartbeatConfig;
  ack?: AckConfig;
  offlineQueue?: OfflineQueueConfig;
  persistence?: PersistenceConfig;
  retry?: RetryConfig;
}

// ============================================================================
// Phase 2: Redis Key Patterns
// ============================================================================

/** Redis key patterns for Phase 2 features */
export const REDIS_KEYS = {
  OFFLINE_QUEUE: (botId: string) => `clawteam:offline:${botId}`,
  MESSAGE_HISTORY: (botId: string) => `clawteam:messages:${botId}`,
  PENDING_ACK: (messageId: string) => `clawteam:pending_ack:${messageId}`,
  DEAD_LETTER: (botId: string) => `clawteam:dead_letter:${botId}`,
} as const;
