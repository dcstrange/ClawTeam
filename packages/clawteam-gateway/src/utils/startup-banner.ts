/**
 * Startup Banner
 *
 * Prints a formatted startup banner to the terminal (bypasses pino)
 * showing configuration overview at a glance.
 */

import type { GatewayConfig } from '../config.js';

const BOX_WIDTH = 56;
const INNER_WIDTH = BOX_WIDTH - 4; // 2 for "│  " left + 2 for right padding + "│"

function pad(text: string): string {
  const visible = stripAnsi(text);
  const padding = INNER_WIDTH - visible.length;
  return padding > 0 ? text + ' '.repeat(padding) : text;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

function line(text: string): string {
  return `│  ${pad(text)}  │`;
}

function separator(): string {
  return `├${'─'.repeat(BOX_WIDTH - 2)}┤`;
}

function top(): string {
  return `┌${'─'.repeat(BOX_WIDTH - 2)}┐`;
}

function bottom(): string {
  return `└${'─'.repeat(BOX_WIDTH - 2)}┘`;
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function formatKv(key: string, value: string, keyWidth = 14): string {
  return `${key.padEnd(keyWidth)}${value}`;
}

function moduleStatus(enabled: boolean, name: string, detail: string, nameWidth = 13): string {
  const icon = enabled ? '\u2714' : '\u2718';
  return `${icon} ${name.padEnd(nameWidth)}${detail}`;
}

export function printStartupBanner(config: GatewayConfig): void {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const lines: string[] = [
    top(),
    line('ClawTeam Gateway'),
    line(`Started: ${now}`),
    separator(),
    line(formatKv('Provider', config.sessionProvider ?? 'openclaw')),
    line(formatKv('Mode', config.openclawMode)),
    line(formatKv('Agent', config.mainAgentId)),
    line(formatKv('API', config.clawteamApiUrl)),
    separator(),
    line('Modules'),
    line(moduleStatus(
      true,
      'Poller',
      `every ${formatMs(config.pollIntervalMs)}, limit ${config.pollLimit}`,
    )),
    line(moduleStatus(
      config.heartbeatEnabled,
      'Heartbeat',
      config.heartbeatEnabled ? `every ${formatMs(config.heartbeatIntervalMs)}` : 'disabled',
    )),
    line(moduleStatus(
      config.recoveryEnabled,
      'Recovery',
      config.recoveryEnabled
        ? `every ${formatMs(config.recoveryIntervalMs)}, stale >${formatMs(config.stalenessThresholdMs)}, max ${config.maxRecoveryAttempts}`
        : 'disabled',
    )),
    line(moduleStatus(
      config.gatewayEnabled,
      'Gateway API',
      config.gatewayEnabled ? `:${config.gatewayPort}` : 'disabled',
    )),
    line(moduleStatus(
      config.gatewayProxyEnabled,
      'Proxy',
      config.gatewayProxyEnabled ? '/gateway/*' : 'disabled',
    )),
    separator(),
    line('Logging'),
    line(`Level: ${config.logLevel}`),
    line(`File:  ${config.logDir.replace(/\/$/, '')}/gateway.YYYY-MM-DD.log`),
    bottom(),
  ];

  console.log(lines.join('\n'));
}
