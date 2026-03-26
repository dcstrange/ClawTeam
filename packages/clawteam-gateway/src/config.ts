/**
 * ClawTeam Gateway Configuration
 *
 * Priority: environment variables > ~/.clawteam/config.yaml > code defaults
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';
import type { SessionProviderType } from './providers/types.js';

/** How the Gateway communicates with OpenClaw */
export type OpenClawMode = 'cli' | 'http';

export interface GatewayConfig {
  /** Session provider type: 'openclaw' (default) or 'claude' */
  sessionProvider?: SessionProviderType;
  /** ClawTeam API base URL */
  clawteamApiUrl: string;
  /** ClawTeam API key for authentication */
  clawteamApiKey: string;
  /** Bot ID this gateway represents (registered via OpenClaw) */
  clawteamBotId?: string;
  /** OpenClaw communication mode: 'cli' (default) or 'http' */
  openclawMode: OpenClawMode;
  /** OpenClaw API base URL (only for http mode) */
  openclawApiUrl: string;
  /** OpenClaw API key (optional, only for http mode) */
  openclawApiKey?: string;
  /** Path to openclaw binary (only for cli mode) */
  openclawBin: string;
  /** Polling interval in milliseconds */
  pollIntervalMs: number;
  /** Max tasks to fetch per poll */
  pollLimit: number;
  /** Main agent identifier (agent ID in OpenClaw, e.g. "main", "bob") */
  mainAgentId: string;
  /** Session alive threshold in ms (sessions older than this are considered dead) */
  sessionAliveThresholdMs: number;
  /** OpenClaw home directory for session storage (default: ~/.openclaw) */
  openclawHome: string;
  /** Log level */
  logLevel: string;
  /** Heartbeat interval in milliseconds (default: 30000) */
  heartbeatIntervalMs: number;
  /** Whether heartbeat reporting is enabled (default: true) */
  heartbeatEnabled: boolean;
  /** Whether stale task recovery is enabled (default: true) */
  recoveryEnabled: boolean;
  /** Recovery check interval in milliseconds (default: 120000 = 2min) */
  recoveryIntervalMs: number;
  /** How long a session must be idle before considered stale (default: 300000 = 5min) */
  stalenessThresholdMs: number;
  /** Max recovery attempts per task before giving up (default: 3) */
  maxRecoveryAttempts: number;
  /** How long a tool_calling session can be stuck before treated as dead (default: 600000 = 10min) */
  toolCallingTimeoutMs: number;
  /** Whether the Gateway API server is enabled (default: false) */
  gatewayEnabled: boolean;
  /** Port for the Gateway API server (default: 3100) */
  gatewayPort: number;
  /** Whether the gateway proxy (/gateway/*) is enabled (default: true) */
  gatewayProxyEnabled: boolean;
  /** Directory for log files (default: 'logs/') */
  logDir: string;
}

/** @deprecated Use GatewayConfig instead */
export type TaskRouterConfig = GatewayConfig;

interface YamlConfig {
  provider?: { type?: string };
  api?: { url?: string; key?: string; botId?: string };
  gateway?: { url?: string; enabled?: boolean; port?: number; proxyEnabled?: boolean };
  /** @deprecated Use gateway instead */
  router?: { url?: string; apiEnabled?: boolean; apiPort?: number };
  openclaw?: { mode?: string; bin?: string; home?: string; mainAgentId?: string; apiUrl?: string; apiKey?: string };
  polling?: { intervalMs?: number; limit?: number };
  logging?: { level?: string; dir?: string };
  heartbeat?: { enabled?: boolean; intervalMs?: number };
  recovery?: { enabled?: boolean; intervalMs?: number; stalenessThresholdMs?: number; maxAttempts?: number; toolCallingTimeoutMs?: number };
  session?: { aliveThresholdMs?: number };
}

function loadYamlConfig(): YamlConfig {
  const configPath = path.join(os.homedir(), '.clawteam', 'config.yaml');

  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return parse(raw) ?? {};
  } catch (err) {
    console.warn(`[config] Failed to parse ${configPath}, falling back to env vars:`, err);
    return {};
  }
}

function resolvePath(value: string): string {
  return value.startsWith('~') ? value.replace(/^~(?=\/|$)/, os.homedir()) : value;
}

export function loadConfig(): GatewayConfig {
  const yaml = loadYamlConfig();

  const clawteamApiKey = process.env.CLAWTEAM_API_KEY || yaml.api?.key;
  if (!clawteamApiKey) {
    throw new Error(
      'API key is required. Set CLAWTEAM_API_KEY env var or api.key in ~/.clawteam/config.yaml.'
    );
  }

  // Session provider type (default: 'openclaw' for backward compatibility)
  const sessionProvider = (process.env.SESSION_PROVIDER || yaml.provider?.type || 'openclaw') as SessionProviderType;

  const openclawMode = (process.env.OPENCLAW_MODE || yaml.openclaw?.mode || 'cli') as OpenClawMode;
  // openclawMode 验证仅在 openclaw provider 中执行（已移至 provider-factory.ts）
  // 避免 Claude provider 启动时因残留的无效 OPENCLAW_MODE 环境变量而崩溃

  const openclawHomeEnv = process.env.OPENCLAW_HOME?.trim();
  const openclawHome = openclawHomeEnv
    ? resolvePath(openclawHomeEnv)
    : (yaml.openclaw?.home ? resolvePath(yaml.openclaw.home) : undefined)
      || path.join(os.homedir(), '.openclaw');

  // gateway section with router fallback
  const gw = yaml.gateway;
  const rt = yaml.router;

  return {
    sessionProvider,
    clawteamApiUrl: process.env.CLAWTEAM_API_URL || yaml.api?.url || 'http://localhost:3000',
    clawteamApiKey,
    clawteamBotId: process.env.CLAWTEAM_BOT_ID || yaml.api?.botId || undefined,
    openclawMode,
    openclawApiUrl: process.env.OPENCLAW_API_URL || yaml.openclaw?.apiUrl || 'http://localhost:3001',
    openclawApiKey: process.env.OPENCLAW_API_KEY || yaml.openclaw?.apiKey || undefined,
    openclawBin: process.env.OPENCLAW_BIN || yaml.openclaw?.bin || 'openclaw',
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '', 10) || yaml.polling?.intervalMs || 15000,
    pollLimit: parseInt(process.env.POLL_LIMIT || '', 10) || yaml.polling?.limit || 10,
    mainAgentId: process.env.MAIN_AGENT_ID || yaml.openclaw?.mainAgentId || 'main',
    sessionAliveThresholdMs: parseInt(process.env.SESSION_ALIVE_THRESHOLD_MS || '', 10) || yaml.session?.aliveThresholdMs || 24 * 60 * 60 * 1000,
    openclawHome,
    logLevel: process.env.LOG_LEVEL || yaml.logging?.level || 'info',
    heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '', 10) || yaml.heartbeat?.intervalMs || 30000,
    heartbeatEnabled: process.env.HEARTBEAT_ENABLED !== undefined ? process.env.HEARTBEAT_ENABLED !== 'false' : yaml.heartbeat?.enabled ?? true,
    recoveryEnabled: process.env.RECOVERY_ENABLED !== undefined ? process.env.RECOVERY_ENABLED !== 'false' : yaml.recovery?.enabled ?? true,
    recoveryIntervalMs: parseInt(process.env.RECOVERY_INTERVAL_MS || '', 10) || yaml.recovery?.intervalMs || 120000,
    stalenessThresholdMs: parseInt(process.env.STALENESS_THRESHOLD_MS || '', 10) || yaml.recovery?.stalenessThresholdMs || 300000,
    maxRecoveryAttempts: parseInt(process.env.MAX_RECOVERY_ATTEMPTS || '', 10) || yaml.recovery?.maxAttempts || 3,
    toolCallingTimeoutMs: parseInt(process.env.TOOL_CALLING_TIMEOUT_MS || '', 10) || yaml.recovery?.toolCallingTimeoutMs || 600_000,
    gatewayEnabled: process.env.GATEWAY_ENABLED !== undefined
      ? process.env.GATEWAY_ENABLED === 'true'
      : (process.env.ROUTER_API_ENABLED !== undefined ? process.env.ROUTER_API_ENABLED === 'true' : gw?.enabled ?? rt?.apiEnabled ?? false),
    gatewayPort: parseInt(process.env.GATEWAY_PORT || process.env.ROUTER_API_PORT || '', 10) || gw?.port || rt?.apiPort || 3100,
    gatewayProxyEnabled: process.env.GATEWAY_PROXY_ENABLED !== undefined
      ? process.env.GATEWAY_PROXY_ENABLED !== 'false'
      : gw?.proxyEnabled ?? true,
    logDir: process.env.LOG_DIR || yaml.logging?.dir || 'logs/',
  };
}
