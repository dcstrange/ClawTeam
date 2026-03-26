/**
 * Visual Log — Structured terminal output for Router events
 *
 * Provides ANSI-colored, box-drawing formatted output for:
 * - Route decisions (three-section card: Task / Decision / Result)
 * - Recovery blocks (four-section card: Task / Detect / Action / Result)
 * - Recovery tick summaries (single line)
 * - Poll tick summaries (single line)
 *
 * pino logger is NOT replaced — this is additive console.log output only.
 */

// ── ANSI color helpers ──────────────────────────────────────────────────────

export const c = {
  red:      (s: string) => `\x1b[31m${s}\x1b[0m`,
  green:    (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow:   (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue:     (s: string) => `\x1b[34m${s}\x1b[0m`,
  magenta:  (s: string) => `\x1b[35m${s}\x1b[0m`,
  cyan:     (s: string) => `\x1b[36m${s}\x1b[0m`,
  gray:     (s: string) => `\x1b[90m${s}\x1b[0m`,
  white:    (s: string) => `\x1b[97m${s}\x1b[0m`,
  bold:     (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:      (s: string) => `\x1b[2m${s}\x1b[0m`,
  bgRed:    (s: string) => `\x1b[41;97m${s}\x1b[0m`,
  bgYellow: (s: string) => `\x1b[43;30m${s}\x1b[0m`,
  bgGreen:  (s: string) => `\x1b[42;30m${s}\x1b[0m`,
};

// ── Strip ANSI for visible-width calculation ────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

// ── Box-drawing helpers ─────────────────────────────────────────────────────

function getBoxWidth(): number {
  return Math.max(60, Math.min(process.stdout.columns ?? 80, 90));
}

export function boxTop(title: string, width?: number): string {
  const w = width ?? getBoxWidth();
  const inner = w - 2;
  const label = ` ${title} `;
  const rest = inner - 2 - visibleLength(label); // "┌─" + label + "─…─┐"
  return `┌─${label}${'─'.repeat(Math.max(0, rest))}┐`;
}

export function boxSep(title: string, width?: number): string {
  const w = width ?? getBoxWidth();
  const inner = w - 2;
  const label = ` ${title} `;
  const rest = inner - 2 - visibleLength(label);
  return `├─${label}${'─'.repeat(Math.max(0, rest))}┤`;
}

export function boxBottom(width?: number): string {
  const w = width ?? getBoxWidth();
  return `└${'─'.repeat(w - 2)}┘`;
}

export function boxLine(text: string, width?: number): string {
  const w = width ?? getBoxWidth();
  const inner = w - 4;
  const pad = inner - visibleLength(text);
  return `│ ${text}${' '.repeat(Math.max(0, pad))} │`;
}

function boxKV(label: string, value: string, labelWidth = 14, width?: number): string {
  const w = width ?? getBoxWidth();
  const paddedLabel = c.dim(label.padEnd(labelWidth));
  return boxLine(`${paddedLabel}${value}`, w);
}

function timestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// ── Session / Task state icons ──────────────────────────────────────────────

export function sessionStateIcon(state: string): string {
  switch (state) {
    case 'active':       return c.green('●');
    case 'tool_calling': return c.blue('⚙');
    case 'waiting':      return c.cyan('◉');
    case 'idle':         return c.yellow('○');
    case 'completed':    return c.cyan('✔');
    case 'errored':      return c.red('✖');
    case 'dead':         return c.red('✖');
    default:             return c.gray('?');
  }
}

export function sessionStateColor(state: string, text: string): string {
  switch (state) {
    case 'active':       return c.green(text);
    case 'tool_calling': return c.blue(text);
    case 'waiting':      return c.cyan(text);
    case 'idle':         return c.yellow(text);
    case 'completed':    return c.cyan(text);
    case 'errored':      return c.red(text);
    case 'dead':         return c.red(text);
    default:             return c.gray(text);
  }
}

export function taskStatusIcon(status: string): string {
  switch (status) {
    case 'pending':    return c.yellow('◌');
    case 'accepted':   return c.blue('◎');
    case 'processing': return c.blue('⚙');
    case 'completed':  return c.green('✔');
    case 'failed':     return c.red('✖');
    case 'timeout':    return c.red('⏱');
    case 'cancelled':  return c.gray('⊘');
    default:           return c.gray('?');
  }
}

// ── Data structures ─────────────────────────────────────────────────────────

export interface RouteBlockInfo {
  taskId: string;
  taskType: string;
  capability?: string;
  prompt?: string;
  title?: string;
  action: string;
  targetSessionKey?: string;
  reason: string;
  success: boolean;
  fallback?: boolean;
  error?: string;
  isDm?: boolean;
  fromBotId?: string;
  toBotId?: string;
  priority?: string;
  parentTaskId?: string;
  tracked?: boolean;
  sessionAlive?: boolean;
  sessionRestored?: boolean;
}

export interface RecoveryStep {
  label: string;
  ok: boolean;
  detail: string;
}

export interface RecoveryBlockInfo {
  taskId: string;
  capability: string;
  sessionKey: string;
  sessionState: string;
  idleMs: number | null;
  taskStatus: string;
  steps: RecoveryStep[];
  outcome: { success: boolean; summary: string };
  thresholdMs?: number;
  attemptNum?: number;
  maxAttempts?: number;
}

export interface RecoveryTickStats {
  total: number;
  recovered: number;
  skipped: number;
  cleaned: number;
}

export interface PollTickStats {
  fetched: number;
  routed: number;
  failed: number;
  skipped: number;
}

// ── Print functions ─────────────────────────────────────────────────────────

/**
 * Print a box-style route decision block.
 *
 * Three-section card: Task / Decision / Result
 * DM variant: Message ID / From Bot / Task Context
 */
export function printRouteBlock(info: RouteBlockInfo): void {
  const w = getBoxWidth();
  const lines: string[] = [];

  // ── Top line ──
  const title = info.isDm ? '💬 DM Route' : '📋 Route';
  lines.push(boxTop(title, w));

  // ── Timestamp ──
  lines.push(boxLine(c.dim(timestamp()), w));

  // ── Task section ──
  lines.push(boxSep('Task', w));

  if (info.isDm) {
    boxKVPush(lines, 'Message ID', shortId(info.taskId), w);
    if (info.fromBotId) {
      boxKVPush(lines, 'From Bot', c.gray(info.fromBotId), w);
    }
    const cap = info.capability ?? '';
    const taskCtx = cap.startsWith('task:')
      ? cap.replace('task:', '')
      : cap;
    boxKVPush(lines, 'Task Context', c.gray(taskCtx), w);
    if (info.priority) {
      boxKVPush(lines, 'Priority', info.priority, w);
    }
  } else {
    boxKVPush(lines, 'ID', shortId(info.taskId), w);
    if (info.title) boxKVPush(lines, 'Title', info.title, w);
    if (info.prompt) {
      const truncated = info.prompt.length > 60 ? info.prompt.slice(0, 57) + '...' : info.prompt;
      boxKVPush(lines, 'Prompt', truncated, w);
    }
    if (info.capability && info.capability !== 'general') boxKVPush(lines, 'Capability', info.capability, w);
    boxKVPush(lines, 'Type', info.taskType, w);
    boxKVPush(lines, 'Priority', info.priority || 'normal', w);
    const from = info.fromBotId || '-';
    const to = info.toBotId || '-';
    boxKVPush(lines, 'From → To', `${from} → ${to}`, w);
    boxKVPush(lines, 'Parent', info.parentTaskId ? shortId(info.parentTaskId) : '-', w);
  }

  // ── Session alive check / fallback (before Decision) ──
  if (info.sessionAlive === false && info.fallback) {
    const sessionLabel = info.targetSessionKey
      ? `session:${shortSession(info.targetSessionKey)}`
      : 'session';
    if (info.sessionRestored) {
      lines.push(boxLine(`${c.dim('Session'.padEnd(14))}${c.green('✓')} ${c.gray(sessionLabel)} (restored)`, w));
    } else {
      lines.push(boxLine(`${c.dim('Session'.padEnd(14))}${c.red('✗')} ${c.gray(sessionLabel)} (expired)`, w));
    }
  }

  // ── Decision section ──
  lines.push(boxSep('Decision', w));
  const target = info.action === 'send_to_session' && info.targetSessionKey
    ? `session:${shortSession(info.targetSessionKey)}`
    : 'main';
  const reasonHint = info.fallback
    ? '(fallback — with parent context)'
    : extractHint(info.reason);
  lines.push(boxLine(`→ ${c.blue(target)}${reasonHint ? ' ' + c.gray(reasonHint) : ''}`, w));

  // ── Result section ──
  lines.push(boxSep('Result', w));
  if (info.success) {
    const trackSuffix = info.tracked
      ? ` │ tracked ${shortId(info.taskId)} ↔ session`
      : '';
    lines.push(boxLine(`${c.green('✓')} sent${trackSuffix}`, w));
  } else {
    lines.push(boxLine(`${c.red('✗')} ${info.error || 'send failed'}`, w));
  }

  lines.push(boxBottom(w));
  console.log(lines.join('\n'));
}

/**
 * Print a full recovery block with box-drawing.
 *
 * Four-section card: Task / Detect / Action / Result
 */
export function printRecoveryBlock(info: RecoveryBlockInfo): void {
  const w = getBoxWidth();
  const lines: string[] = [];

  lines.push(boxTop('🔄 Recovery', w));

  // ── Timestamp + attempt (right-aligned) ──
  const ts = c.dim(timestamp());
  if (info.attemptNum != null && info.maxAttempts != null) {
    const attemptTag = `attempt ${info.attemptNum}/${info.maxAttempts}`;
    const inner = w - 4;
    const leftLen = visibleLength(ts);
    const rightLen = attemptTag.length;
    const gap = inner - leftLen - rightLen;
    lines.push(boxLine(`${ts}${' '.repeat(Math.max(1, gap))}${c.dim(attemptTag)}`, w));
  } else {
    lines.push(boxLine(ts, w));
  }

  // ── Task section ──
  lines.push(boxSep('Task', w));
  boxKVPush(lines, 'ID', shortId(info.taskId), w);
  boxKVPush(lines, 'Capability', info.capability, w);
  boxKVPush(lines, 'Session', c.gray(shortSession(info.sessionKey)), w);

  // ── Detect section ──
  lines.push(boxSep('Detect', w));
  const stateIcon = sessionStateIcon(info.sessionState);
  const stateLabel = sessionStateColor(info.sessionState, info.sessionState.toUpperCase());

  let idleSuffix = '';
  if (info.idleMs !== null && info.thresholdMs) {
    const durSec = Math.round(info.idleMs / 1000);
    const threshSec = Math.round(info.thresholdMs / 1000);
    const label = info.sessionState === 'tool_calling' ? 'timeout' : 'threshold';
    idleSuffix = c.gray(` (${durSec}s > ${threshSec}s ${label})`);
  } else if (info.idleMs !== null) {
    idleSuffix = c.gray(` (stale ${Math.round(info.idleMs / 1000)}s)`);
  }
  boxKVPush(lines, 'Session', `${stateIcon} ${stateLabel}${idleSuffix}`, w);
  boxKVPush(lines, 'Task', `${taskStatusIcon(info.taskStatus)} ${info.taskStatus}`, w);

  // ── Action section ──
  lines.push(boxSep('Action', w));
  const ACTION_LABEL_WIDTH = 30;
  for (const step of info.steps) {
    const icon = step.ok ? c.green('✓') : c.red('✗');
    const padded = step.label.length < ACTION_LABEL_WIDTH
      ? step.label + ' '.repeat(ACTION_LABEL_WIDTH - step.label.length)
      : step.label;
    lines.push(boxLine(`${padded} ${icon} ${step.detail}`, w));
  }

  // ── Result section ──
  lines.push(boxSep('Result', w));
  const outcomeIcon = info.outcome.success ? c.green('✓') : c.red('✗');
  lines.push(boxLine(`${outcomeIcon} ${info.outcome.summary}`, w));

  lines.push(boxBottom(w));

  console.log(lines.join('\n'));
}

/**
 * Print a single-line cleanup/terminal notice.
 */
export function printCleanupLine(taskId: string, detail: string): void {
  console.log(`  ${c.gray('○ CLEANUP')}  ${shortId(taskId)} │ ${c.gray(detail)}`);
}

/**
 * Print a compact recovery tick summary.
 */
export function printRecoveryTickSummary(stats: RecoveryTickStats): void {
  const parts: string[] = [];
  if (stats.recovered > 0) {
    parts.push(c.green(`recovered: ${stats.recovered}`));
  } else {
    parts.push(`recovered: ${stats.recovered}`);
  }
  parts.push(`skipped: ${stats.skipped}`);
  if (stats.cleaned > 0) {
    parts.push(c.gray(`cleaned: ${stats.cleaned}`));
  } else {
    parts.push(`cleaned: ${stats.cleaned}`);
  }

  console.log(`  ${c.dim('──')} Recovery Tick ${c.dim('──')} ${stats.total} tasks │ ${parts.join('  ')}`);
}

/**
 * Print a compact poll tick summary. Only call when fetched > 0.
 */
export function printPollTickSummary(stats: PollTickStats): void {
  const parts: string[] = [
    `routed: ${stats.routed}`,
    `skipped: ${stats.skipped}`,
    `failed: ${stats.failed}`,
  ];
  console.log(`  ${c.dim('──')} Poll ${c.dim('──')} ${stats.fetched} fetched │ ${parts.join('  ')}`);
}

/**
 * Colorize a session state tag (used by recovery loop logging).
 */
export function colorizeState(state: string, idleMs: number | null): string {
  const dur = idleMs !== null ? ` ${Math.round(idleMs / 1000)}s` : '';
  switch (state) {
    case 'dead':      return c.bgRed(` DEAD SESSION `);
    case 'errored':   return c.red(`ERRORED${dur}`);
    case 'idle':      return c.yellow(`IDLE STALE${dur}`);
    case 'completed': return c.cyan(`SESSION COMPLETED (task active)${dur}`);
    default:          return c.yellow(`STALE [${state}]${dur}`);
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

function shortId(id: string): string {
  // Show first 12 chars of UUID-like IDs, full string otherwise
  return id.length > 16 ? id.slice(0, 12) + '…' : id;
}

function shortSession(key: string): string {
  // Provider-agnostic: shows last segment of any colon-separated key
  // OpenClaw "agent:main:subagent:abc-def-..." → "…:abc-def…"
  // Claude "claude:f47ac10b-..." → "…:f47ac10b…"
  const parts = key.split(':');
  if (parts.length <= 2) return key;
  const last = parts[parts.length - 1];
  return `…:${last.length > 12 ? last.slice(0, 12) + '…' : last}`;
}

function extractHint(reason: string): string {
  // Pull out parenthetical hints like "(resolved via parentTaskId)"
  if (reason.includes('resolved session')) return '(resolved via parentTaskId)';
  if (reason.includes('fallback')) return '(fallback)';
  if (reason.includes('target session')) return '(target session)';
  // Extract hint for new task routing
  if (reason.includes('main session will spawn')) return '(new task — main session will spawn sub-session)';
  return '';
}

/** Push a boxKV line into the lines array. */
function boxKVPush(lines: string[], label: string, value: string, width: number): void {
  lines.push(boxKV(label, value, 14, width));
}
