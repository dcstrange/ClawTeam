#!/usr/bin/env node
/**
 * CLI Status — Interactive Session Monitor
 *
 * Interactive TUI for viewing OpenClaw session status.
 * Arrow keys to navigate, Enter to view details, q to quit.
 *
 * Falls back to non-interactive output when stdout is not a TTY
 * or when --json is passed.
 *
 * Usage:
 *   npm run task-status                    # Interactive TUI (default)
 *   npm run task-status -- --json          # Non-interactive JSON
 *   npm run task-status -- --agent bob     # Filter by agent
 *   npm run task-status -- -n 20           # Show last 20 messages in detail
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyzeTail, buildJsonlPath, readLastMessages } from './jsonl-analyzer.js';
import type { ParsedMessage, ContentBlock } from './jsonl-analyzer.js';
import { deriveState } from './session-status-resolver.js';
import type { SessionState, JsonlAnalysis } from './types.js';

/** On Windows, execFile needs shell:true to resolve .cmd shims */
const IS_WINDOWS = os.platform() === 'win32';

const execFileAsync = promisify(execFile);

// ── ANSI helpers ───────────────────────────────────────────────

const ESC = '\x1B[';
const ansi = {
  clearScreen: `${ESC}2J${ESC}H`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  inverse: `${ESC}7m`,
  reset: `${ESC}0m`,
  cyan: `${ESC}36m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  red: `${ESC}31m`,
  gray: `${ESC}90m`,
  white: `${ESC}37m`,
  bgBlue: `${ESC}44m`,
};

// ── Types ──────────────────────────────────────────────────────

interface StatusEntry {
  agentId: string;
  sessionKey: string;
  sessionId: string | null;
  state: SessionState;
  alive: boolean;
  ageMs: number | null;
  lastRole: string | null;
  lastStop: string | null;
  toolCalls: number;
  messages: number;
  model: string | null;
  error: string | null;
}

interface AppOptions {
  agentFilter: string | undefined;
  messageCount: number;
  refreshIntervalSec: number;
  openclawHome: string;
  openclawBin: string;
  thresholdMs: number;
}

type View = 'list' | 'detail' | 'message';

// ── Interactive TUI ────────────────────────────────────────────

class InteractiveTUI {
  private opts: AppOptions;
  private entries: StatusEntry[] = [];
  private cursor = 0;
  private scrollOffset = 0;
  private view: View = 'list';
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private termRows = 24;
  private termCols = 80;

  // Detail view state
  private detailHeaderLines: string[] = [];
  private detailMessages: ParsedMessage[] = [];
  private messageCursor = 0;
  private detailScrollOffset = 0;

  // Message full view state
  private messageLines: string[] = [];
  private messageScroll = 0;

  constructor(opts: AppOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    // Initial data load
    this.entries = await collectEntries(this.opts);
    this.updateTermSize();

    // Setup terminal
    process.stdout.write(ansi.hideCursor);
    process.stdout.write(ansi.clearScreen);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    readline.emitKeypressEvents(process.stdin);

    process.stdin.on('keypress', (_str, key) => this.handleKey(key));
    process.stdout.on('resize', () => {
      this.updateTermSize();
      this.render();
    });

    // Auto-refresh
    this.refreshTimer = setInterval(async () => {
      this.entries = await collectEntries(this.opts);
      // Clamp cursor
      if (this.cursor >= this.entries.length) {
        this.cursor = Math.max(0, this.entries.length - 1);
      }
      this.render();
    }, this.opts.refreshIntervalSec * 1000);

    // Graceful exit
    process.on('SIGINT', () => this.exit());
    process.on('SIGTERM', () => this.exit());

    // First render
    this.render();
  }

  private exit(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    process.stdout.write(ansi.showCursor);
    process.stdout.write(ansi.clearScreen);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.exit(0);
  }

  private updateTermSize(): void {
    this.termRows = process.stdout.rows || 24;
    this.termCols = process.stdout.columns || 80;
  }

  private handleKey(key: readline.Key | undefined): void {
    if (!key) return;

    // Global: Ctrl-C to quit
    if (key.ctrl && key.name === 'c') {
      this.exit();
      return;
    }

    if (this.view === 'list') {
      // q quits from list
      if (key.name === 'q' && !key.ctrl) {
        this.exit();
        return;
      }
      this.handleListKey(key);
    } else if (this.view === 'detail') {
      this.handleDetailKey(key);
    } else {
      this.handleMessageKey(key);
    }
  }

  private handleListKey(key: readline.Key): void {
    const len = this.entries.length;
    if (len === 0) return;

    switch (key.name) {
      case 'up':
      case 'k':
        this.cursor = Math.max(0, this.cursor - 1);
        this.ensureVisible();
        this.render();
        break;
      case 'down':
      case 'j':
        this.cursor = Math.min(len - 1, this.cursor + 1);
        this.ensureVisible();
        this.render();
        break;
      case 'home':
      case 'g':
        this.cursor = 0;
        this.scrollOffset = 0;
        this.render();
        break;
      case 'end':
        this.cursor = len - 1;
        this.ensureVisible();
        this.render();
        break;
      case 'return':
        this.openDetail();
        break;
      case 'r':
        // Manual refresh
        this.refreshNow();
        break;
    }
  }

  private handleDetailKey(key: readline.Key): void {
    const msgLen = this.detailMessages.length;

    switch (key.name) {
      case 'escape':
      case 'backspace':
      case 'q':
      case 'left':
        this.view = 'list';
        this.render();
        break;
      case 'up':
      case 'k':
        if (msgLen > 0) {
          this.messageCursor = Math.max(0, this.messageCursor - 1);
          this.ensureMessageVisible();
        }
        this.render();
        break;
      case 'down':
      case 'j':
        if (msgLen > 0) {
          this.messageCursor = Math.min(msgLen - 1, this.messageCursor + 1);
          this.ensureMessageVisible();
        }
        this.render();
        break;
      case 'home':
      case 'g':
        this.messageCursor = 0;
        this.detailScrollOffset = 0;
        this.render();
        break;
      case 'end':
        if (msgLen > 0) {
          this.messageCursor = msgLen - 1;
          this.ensureMessageVisible();
        }
        this.render();
        break;
      case 'return':
        if (msgLen > 0) {
          this.openMessage();
        }
        break;
      case 'r':
        this.refreshNow();
        break;
    }
  }

  private handleMessageKey(key: readline.Key): void {
    switch (key.name) {
      case 'escape':
      case 'backspace':
      case 'q':
      case 'left':
        this.view = 'detail';
        this.messageScroll = 0;
        this.render();
        break;
      case 'up':
      case 'k':
        this.messageScroll = Math.max(0, this.messageScroll - 1);
        this.render();
        break;
      case 'down':
      case 'j':
        this.messageScroll = Math.min(
          Math.max(0, this.messageLines.length - (this.termRows - 4)),
          this.messageScroll + 1,
        );
        this.render();
        break;
      case 'pageup':
        this.messageScroll = Math.max(0, this.messageScroll - (this.termRows - 6));
        this.render();
        break;
      case 'pagedown':
      case 'space':
        this.messageScroll = Math.min(
          Math.max(0, this.messageLines.length - (this.termRows - 4)),
          this.messageScroll + (this.termRows - 6),
        );
        this.render();
        break;
      case 'home':
      case 'g':
        this.messageScroll = 0;
        this.render();
        break;
      case 'end':
        this.messageScroll = Math.max(0, this.messageLines.length - (this.termRows - 4));
        this.render();
        break;
    }
  }

  private async refreshNow(): Promise<void> {
    this.entries = await collectEntries(this.opts);
    if (this.cursor >= this.entries.length) {
      this.cursor = Math.max(0, this.entries.length - 1);
    }
    if (this.view === 'detail') {
      this.loadDetailData();
    }
    this.render();
  }

  private openDetail(): void {
    if (this.entries.length === 0) return;
    this.view = 'detail';
    this.messageCursor = 0;
    this.detailScrollOffset = 0;
    this.loadDetailData();
    this.render();
  }

  private loadDetailData(): void {
    const e = this.entries[this.cursor];
    if (!e) return;

    // Build header lines (session metadata)
    this.detailHeaderLines = this.buildSessionHeader(e);

    // Load messages
    if (e.sessionId) {
      const jsonlPath = buildJsonlPath(this.opts.openclawHome, e.agentId, e.sessionId);
      this.detailMessages = readLastMessages(jsonlPath, this.opts.messageCount);
    } else {
      this.detailMessages = [];
    }

    // Clamp message cursor
    if (this.messageCursor >= this.detailMessages.length) {
      this.messageCursor = Math.max(0, this.detailMessages.length - 1);
    }
  }

  private openMessage(): void {
    if (this.detailMessages.length === 0) return;
    this.view = 'message';
    this.messageScroll = 0;
    this.messageLines = this.buildMessageLines(this.detailMessages[this.messageCursor]);
    this.render();
  }

  private ensureVisible(): void {
    const visibleRows = this.termRows - 6; // header(3) + footer(2) + summary(1)
    if (this.cursor < this.scrollOffset) {
      this.scrollOffset = this.cursor;
    } else if (this.cursor >= this.scrollOffset + visibleRows) {
      this.scrollOffset = this.cursor - visibleRows + 1;
    }
  }

  private ensureMessageVisible(): void {
    // Messages area starts after header lines + 1 blank + 1 "Messages" title + 1 blank
    const headerHeight = this.detailHeaderLines.length + 3;
    const visibleMsgRows = this.termRows - 5 - headerHeight; // title(2) + blank + footer(2)
    if (visibleMsgRows <= 0) return;

    // Each message row is 1 line in the list
    if (this.messageCursor < this.detailScrollOffset) {
      this.detailScrollOffset = this.messageCursor;
    } else if (this.messageCursor >= this.detailScrollOffset + visibleMsgRows) {
      this.detailScrollOffset = this.messageCursor - visibleMsgRows + 1;
    }
  }

  // ── Render ─────────────────────────────────────────────────

  private render(): void {
    process.stdout.write(ansi.clearScreen);

    if (this.view === 'list') {
      this.renderList();
    } else if (this.view === 'detail') {
      this.renderDetail();
    } else {
      this.renderMessage();
    }
  }

  private renderList(): void {
    const w = this.termCols;
    const now = new Date().toLocaleTimeString();

    // Title bar
    const title = ` task-status  ${ansi.dim}${now}  ${this.entries.length} sessions  refresh: ${this.opts.refreshIntervalSec}s${ansi.reset}`;
    writeLine(`${ansi.bold}${ansi.cyan}${title}${ansi.reset}`);
    writeLine(`${ansi.dim}  ↑↓/jk: navigate  Enter: detail  r: refresh  q: quit${ansi.reset}`);
    writeLine('');

    if (this.entries.length === 0) {
      writeLine('  No sessions found.');
      return;
    }

    // Table header
    const cols = buildColumnDefs(w);
    const headerStr = cols.map((c) => c.label.padEnd(c.width)).join(' ');
    writeLine(`${ansi.bold}${ansi.dim}  ${headerStr}${ansi.reset}`);

    // Visible rows
    const visibleRows = this.termRows - 7; // title(2) + blank + header + blank + footer + summary
    const start = this.scrollOffset;
    const end = Math.min(this.entries.length, start + visibleRows);

    for (let i = start; i < end; i++) {
      const e = this.entries[i];
      const selected = i === this.cursor;
      const row = formatRow(e, cols);

      if (selected) {
        writeLine(`${ansi.inverse}${ansi.bold}> ${row}${ansi.reset}`);
      } else {
        const color = stateColor(e.state);
        writeLine(`  ${color}${row}${ansi.reset}`);
      }
    }

    // Scroll indicator
    if (this.entries.length > visibleRows) {
      const pct = Math.round(((this.cursor + 1) / this.entries.length) * 100);
      writeLine('');
      writeLine(`${ansi.dim}  ${this.cursor + 1}/${this.entries.length} (${pct}%)${ansi.reset}`);
    }

    // Summary line at bottom
    const stateCounts = new Map<string, number>();
    for (const e of this.entries) {
      stateCounts.set(e.state, (stateCounts.get(e.state) || 0) + 1);
    }
    const summary = Array.from(stateCounts.entries())
      .map(([s, c]) => `${s}:${c}`)
      .join('  ');
    writeLine(`${ansi.dim}  ${summary}${ansi.reset}`);
  }

  private buildSessionHeader(e: StatusEntry): string[] {
    const w = this.termCols;
    const sep = '─'.repeat(Math.min(60, w - 4));
    const lines: string[] = [];

    const icon = getStateIcon(e.state);
    const color = stateColor(e.state);
    lines.push(`  ${ansi.bold}State:${ansi.reset}       ${color}${icon} ${e.state}${ansi.reset}`);
    lines.push(`  ${ansi.bold}Agent:${ansi.reset}       ${e.agentId}`);
    lines.push(`  ${ansi.bold}Session Key:${ansi.reset} ${e.sessionKey}`);
    lines.push(`  ${ansi.bold}Session ID:${ansi.reset}  ${e.sessionId ?? ansi.dim + '(unknown)' + ansi.reset}`);
    lines.push(`  ${ansi.bold}Alive:${ansi.reset}       ${e.alive ? ansi.green + 'yes' + ansi.reset : ansi.red + 'no' + ansi.reset}`);
    lines.push(`  ${ansi.bold}Age:${ansi.reset}         ${formatAge(e.ageMs)}`);
    lines.push(`  ${ansi.bold}Model:${ansi.reset}       ${e.model ?? '-'}`);

    if (e.sessionId) {
      const jsonlPath = buildJsonlPath(this.opts.openclawHome, e.agentId, e.sessionId);
      const exists = fs.existsSync(jsonlPath);
      const size = exists ? fs.statSync(jsonlPath).size : 0;
      lines.push(`  ${ansi.bold}JSONL:${ansi.reset}       ${ansi.dim}${formatBytes(size)}${ansi.reset}`);
    }

    if (e.error) {
      lines.push(`  ${ansi.red}Error: ${e.error}${ansi.reset}`);
    }

    lines.push(`  ${ansi.dim}${sep}${ansi.reset}`);
    return lines;
  }

  private renderDetail(): void {
    const now = new Date().toLocaleTimeString();
    const e = this.entries[this.cursor];

    writeLine(`${ansi.bold}${ansi.cyan} Session Detail  ${ansi.dim}${now}${ansi.reset}`);
    writeLine(`${ansi.dim}  ←/Esc: back  ↑↓/jk: navigate messages  Enter: view message  r: refresh${ansi.reset}`);
    writeLine('');

    // Session header (always visible)
    for (const line of this.detailHeaderLines) {
      writeLine(line);
    }

    // Messages section
    const msgLen = this.detailMessages.length;
    if (msgLen === 0) {
      writeLine('');
      writeLine(`  ${ansi.dim}(no messages found)${ansi.reset}`);
      return;
    }

    writeLine(`  ${ansi.bold}Messages${ansi.reset} ${ansi.dim}(${msgLen})${ansi.reset}`);
    writeLine('');

    // Calculate visible message rows
    const usedRows = 3 + this.detailHeaderLines.length + 2; // title bar(2) + blank + header + "Messages" + blank
    const visibleMsgRows = Math.max(1, this.termRows - usedRows - 2); // -2 for footer

    const start = this.detailScrollOffset;
    const end = Math.min(msgLen, start + visibleMsgRows);

    for (let i = start; i < end; i++) {
      const msg = this.detailMessages[i];
      const selected = i === this.messageCursor;
      const row = this.formatMessageRow(msg, i);

      if (selected) {
        writeLine(`${ansi.inverse}${ansi.bold}> ${row}${ansi.reset}`);
      } else {
        const color = roleTagColor(msg.displayRole);
        writeLine(`  ${color}${row}${ansi.reset}`);
      }
    }

    // Footer
    if (msgLen > visibleMsgRows) {
      const pct = Math.round(((this.messageCursor + 1) / msgLen) * 100);
      writeLine('');
      writeLine(`${ansi.dim}  ${this.messageCursor + 1}/${msgLen} (${pct}%)${ansi.reset}`);
    }
  }

  private formatMessageRow(msg: ParsedMessage, index: number): string {
    const w = this.termCols;
    const num = String(index + 1).padStart(3);
    const roleTag = formatRoleTag(msg.displayRole);
    const stopTag = msg.stopReason ? ` [${msg.stopReason}]` : '';
    const toolTag = msg.toolNames.length > 0 ? ` -> ${msg.toolNames.join(',')}` : '';
    const modelTag = msg.model ? ` (${msg.model})` : '';
    const ts = msg.timestamp ? ` ${formatTimestamp(msg.timestamp)}` : '';

    // Meta part
    const meta = `${num}. ${roleTag}${stopTag}${toolTag}${modelTag}${ts}`;

    // Summary — fill remaining width
    const metaLen = stripAnsi(meta).length + 4; // +4 for prefix "  " or "> "
    const summaryWidth = Math.max(20, w - metaLen - 3);
    const summary = truncate(msg.summary.replace(/\n/g, ' '), summaryWidth);

    return `${meta}  ${ansi.dim}${summary}${ansi.reset}`;
  }

  private buildMessageLines(msg: ParsedMessage): string[] {
    const w = this.termCols;
    const sep = '─'.repeat(Math.min(60, w - 4));
    const lines: string[] = [];
    const contentWidth = Math.max(40, w - 6);

    // Header
    const roleColor = roleTagColor(msg.displayRole);
    lines.push(`  ${ansi.bold}${roleColor}${formatRoleTag(msg.displayRole)}${ansi.reset}`);
    lines.push(`  ${ansi.dim}${sep}${ansi.reset}`);

    // Metadata
    if (msg.timestamp) lines.push(`  ${ansi.bold}Time:${ansi.reset}     ${formatTimestamp(msg.timestamp)}`);
    if (msg.model) lines.push(`  ${ansi.bold}Model:${ansi.reset}    ${msg.model}${msg.provider ? ` (${msg.provider})` : ''}`);
    if (msg.stopReason) lines.push(`  ${ansi.bold}Stop:${ansi.reset}     ${msg.stopReason}`);
    if (msg.usage) {
      const u = msg.usage;
      let usageStr = `in: ${u.input}  out: ${u.output}`;
      if (u.cacheRead) usageStr += `  cache: ${u.cacheRead}`;
      lines.push(`  ${ansi.bold}Tokens:${ansi.reset}   ${usageStr}`);
    }
    if (msg.toolNames.length > 0) {
      lines.push(`  ${ansi.bold}Tools:${ansi.reset}    ${ansi.yellow}${msg.toolNames.join(', ')}${ansi.reset}`);
    }
    lines.push('');

    // Content blocks
    for (const block of msg.contentBlocks) {
      switch (block.type) {
        case 'text': {
          lines.push(`  ${ansi.dim}${sep}${ansi.reset}`);
          lines.push(`  ${ansi.bold}Text${ansi.reset}`);
          const textLines = (block.text || '').split('\n');
          for (const tl of textLines) {
            const wrapped = wrapText(tl, contentWidth);
            for (const wl of wrapped) {
              lines.push(`  ${wl}`);
            }
          }
          lines.push('');
          break;
        }
        case 'thinking': {
          lines.push(`  ${ansi.dim}${sep}${ansi.reset}`);
          lines.push(`  ${ansi.bold}${ansi.dim}Thinking${ansi.reset}`);
          const thinkLines = (block.text || '').split('\n');
          for (const tl of thinkLines) {
            const wrapped = wrapText(tl, contentWidth);
            for (const wl of wrapped) {
              lines.push(`  ${ansi.dim}${wl}${ansi.reset}`);
            }
          }
          lines.push('');
          break;
        }
        case 'toolCall': {
          lines.push(`  ${ansi.dim}${sep}${ansi.reset}`);
          lines.push(`  ${ansi.bold}${ansi.yellow}Tool Call: ${block.toolName}${ansi.reset}`);
          if (block.toolArgs) {
            let argsStr: string;
            try {
              argsStr = typeof block.toolArgs === 'string'
                ? block.toolArgs
                : JSON.stringify(block.toolArgs, null, 2);
            } catch {
              argsStr = String(block.toolArgs);
            }
            const argLines = argsStr.split('\n');
            for (const al of argLines) {
              const wrapped = wrapText(al, contentWidth);
              for (const wl of wrapped) {
                lines.push(`  ${ansi.yellow}${wl}${ansi.reset}`);
              }
            }
          }
          lines.push('');
          break;
        }
        case 'toolResult': {
          lines.push(`  ${ansi.dim}${sep}${ansi.reset}`);
          const errTag = block.isError ? ` ${ansi.red}(ERROR)${ansi.reset}` : '';
          const toolLabel = block.toolName ? `Tool Result: ${block.toolName}` : 'Tool Result';
          lines.push(`  ${ansi.bold}${ansi.cyan}${toolLabel}${ansi.reset}${errTag}`);
          if (block.exitCode !== undefined && block.exitCode !== null) {
            lines.push(`  ${ansi.dim}Exit code: ${block.exitCode}${ansi.reset}`);
          }
          if (block.durationMs !== undefined && block.durationMs !== null) {
            lines.push(`  ${ansi.dim}Duration: ${block.durationMs}ms${ansi.reset}`);
          }
          const resultLines = (block.text || '').split('\n');
          for (const rl of resultLines) {
            const wrapped = wrapText(rl, contentWidth);
            for (const wl of wrapped) {
              lines.push(`  ${wl}`);
            }
          }
          lines.push('');
          break;
        }
        default: {
          lines.push(`  ${ansi.dim}[${block.type}]${ansi.reset}`);
          if (block.text) {
            const wrapped = wrapText(block.text, contentWidth);
            for (const wl of wrapped) {
              lines.push(`  ${wl}`);
            }
          }
          lines.push('');
        }
      }
    }

    if (msg.contentBlocks.length === 0) {
      lines.push(`  ${ansi.dim}(no content blocks)${ansi.reset}`);
    }

    return lines;
  }

  private renderMessage(): void {
    const now = new Date().toLocaleTimeString();
    const msg = this.detailMessages[this.messageCursor];
    const idx = this.messageCursor + 1;
    const total = this.detailMessages.length;

    writeLine(`${ansi.bold}${ansi.cyan} Message ${idx}/${total}  ${ansi.dim}${now}${ansi.reset}`);
    writeLine(`${ansi.dim}  ←/Esc: back  ↑↓/jk: scroll  PgUp/PgDn: page${ansi.reset}`);
    writeLine('');

    const visibleRows = this.termRows - 4;
    const start = this.messageScroll;
    const end = Math.min(this.messageLines.length, start + visibleRows);

    for (let i = start; i < end; i++) {
      writeLine(this.messageLines[i]);
    }

    // Scroll indicator
    if (this.messageLines.length > visibleRows) {
      const pct = Math.round(((start + visibleRows) / this.messageLines.length) * 100);
      process.stdout.write(`${ESC}${this.termRows};1H`);
      process.stdout.write(`${ansi.dim}  scroll: ${Math.min(pct, 100)}%  (${start + 1}-${end}/${this.messageLines.length})${ansi.reset}`);
    }
  }
}

// ── Column definitions ─────────────────────────────────────────

interface ColumnDef {
  label: string;
  width: number;
  get: (e: StatusEntry) => string;
}

function buildColumnDefs(termWidth: number): ColumnDef[] {
  // Adaptive: if terminal is wide enough, show more columns
  const narrow = termWidth < 100;

  const cols: ColumnDef[] = [
    { label: 'Agent', width: 8, get: (e) => truncate(e.agentId, 8) },
    {
      label: 'Session Key',
      width: narrow ? 28 : 38,
      get: (e) => truncate(e.sessionKey, narrow ? 28 : 38),
    },
    {
      label: 'State',
      width: 14,
      get: (e) => `${getStateIcon(e.state)} ${e.state}`,
    },
    { label: 'Age', width: 6, get: (e) => formatAge(e.ageMs) },
    { label: 'Role', width: 11, get: (e) => e.lastRole ?? '-' },
    { label: 'Stop', width: 8, get: (e) => e.lastStop ?? '-' },
    { label: 'Tools', width: 5, get: (e) => String(e.toolCalls) },
    { label: 'Msgs', width: 5, get: (e) => String(e.messages) },
  ];

  if (!narrow) {
    cols.push({ label: 'Model', width: 18, get: (e) => truncate(e.model ?? '-', 18) });
  }

  return cols;
}

function formatRow(e: StatusEntry, cols: ColumnDef[]): string {
  return cols.map((c) => c.get(e).padEnd(c.width)).join(' ');
}

// ── Data collection ────────────────────────────────────────────

async function collectEntries(opts: AppOptions): Promise<StatusEntry[]> {
  const agentsDir = path.join(opts.openclawHome, 'agents');
  let agentIds: string[] = [];

  if (fs.existsSync(agentsDir)) {
    agentIds = fs.readdirSync(agentsDir).filter((name) => {
      const sessionsDir = path.join(agentsDir, name, 'sessions');
      return fs.existsSync(sessionsDir);
    });
  }

  if (opts.agentFilter) {
    agentIds = agentIds.filter((id) => id === opts.agentFilter);
  }

  if (agentIds.length === 0) return [];

  const cliSessions = await fetchCliSessions(opts.openclawBin, opts.thresholdMs);
  const entries: StatusEntry[] = [];

  for (const agentId of agentIds) {
    const sessionsJsonPath = path.join(agentsDir, agentId, 'sessions', 'sessions.json');
    if (!fs.existsSync(sessionsJsonPath)) continue;

    let sessionsData: Record<string, any>;
    try {
      sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8'));
    } catch {
      continue;
    }

    for (const [sessionKey, entry] of Object.entries(sessionsData)) {
      const sessionId = (entry as any)?.sessionId ?? null;
      const cliInfo = cliSessions.get(sessionKey);
      const alive = cliInfo?.alive ?? false;
      const ageMs = cliInfo?.ageMs ?? null;

      let analysis: JsonlAnalysis | null = null;
      if (sessionId) {
        const jsonlPath = buildJsonlPath(opts.openclawHome, agentId, sessionId);
        analysis = analyzeTail(jsonlPath);
      }

      const state = deriveState(alive, analysis);

      entries.push({
        agentId,
        sessionKey,
        sessionId,
        state,
        alive,
        ageMs,
        lastRole: analysis?.lastMessageRole ?? null,
        lastStop: analysis?.lastStopReason ?? null,
        toolCalls: analysis?.toolCallCount ?? 0,
        messages: analysis?.messageCount ?? 0,
        model: analysis?.model ?? null,
        error: analysis?.lastErrorMessage ?? null,
      });
    }
  }

  return entries;
}

// ── Non-interactive output (for --json and piped stdout) ───────

function printBatch(entries: StatusEntry[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (entries.length === 0) {
    console.log('No sessions found.');
    return;
  }

  const header = ['Agent', 'Session Key', 'State', 'Alive', 'Age', 'Last Role', 'Stop', 'Tools', 'Msgs', 'Model'];
  const rows = entries.map((e) => [
    e.agentId,
    truncate(e.sessionKey, 40),
    `${getStateIcon(e.state)} ${e.state}`,
    e.alive ? 'yes' : 'no',
    formatAge(e.ageMs),
    e.lastRole ?? '-',
    e.lastStop ?? '-',
    String(e.toolCalls),
    String(e.messages),
    e.model ? truncate(e.model, 20) : '-',
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );

  console.log(header.map((h, i) => h.padEnd(widths[i])).join('  '));
  console.log('-'.repeat(header.map((h, i) => widths[i]).reduce((a, b) => a + b + 2, -2)));
  for (const row of rows) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i])).join('  '));
  }

  const stateCounts = new Map<string, number>();
  for (const e of entries) {
    stateCounts.set(e.state, (stateCounts.get(e.state) || 0) + 1);
  }
  console.log('');
  console.log(
    `Total: ${entries.length} sessions — ` +
    Array.from(stateCounts.entries())
      .map(([s, c]) => `${s}: ${c}`)
      .join(', '),
  );
}

// ── CLI session fetching ───────────────────────────────────────

async function fetchCliSessions(
  openclawBin: string,
  thresholdMs: number,
): Promise<Map<string, { ageMs?: number; updatedAt?: number; alive: boolean }>> {
  const map = new Map<string, { ageMs?: number; updatedAt?: number; alive: boolean }>();
  try {
    const { stdout } = await execFileAsync(openclawBin, ['sessions', '--json'], {
      timeout: 10_000,
      shell: IS_WINDOWS,
    });
    const data = parseJsonOutput(stdout);
    if (data && Array.isArray(data.sessions)) {
      for (const s of data.sessions) {
        const ageMs = s.ageMs ?? (s.updatedAt ? Date.now() - s.updatedAt : undefined);
        map.set(s.key, {
          ageMs,
          updatedAt: s.updatedAt,
          alive: ageMs !== undefined ? ageMs < thresholdMs : false,
        });
      }
    }
  } catch {
    // CLI not available
  }
  return map;
}

// ── Helpers ────────────────────────────────────────────────────

function writeLine(text: string): void {
  process.stdout.write(text + '\n');
}

function stateColor(state: SessionState): string {
  switch (state) {
    case 'active': return ansi.green;
    case 'tool_calling': return ansi.yellow;
    case 'waiting': return ansi.cyan;
    case 'idle': return ansi.dim;
    case 'errored': return ansi.red;
    case 'completed': return ansi.green;
    case 'dead': return ansi.dim;
    case 'unknown': return ansi.dim;
    default: return '';
  }
}

function roleTagColor(role: string): string {
  switch (role) {
    case 'user': return ansi.cyan;
    case 'assistant': return ansi.green;
    case 'toolResult': return ansi.yellow;
    default: return ansi.dim;
  }
}

function getStateIcon(state: SessionState): string {
  switch (state) {
    case 'active': return '●';
    case 'tool_calling': return '⚙';
    case 'waiting': return '◔';
    case 'idle': return '○';
    case 'errored': return '✖';
    case 'completed': return '✔';
    case 'dead': return '✗';
    case 'unknown': return '?';
    default: return ' ';
  }
}

function formatRoleTag(role: string): string {
  switch (role) {
    case 'user': return '[USER]     ';
    case 'assistant': return '[ASSISTANT]';
    case 'toolResult': return '[TOOL_RES] ';
    case 'system': return '[SYSTEM]   ';
    default: return `[${role.toUpperCase().padEnd(9)}]`;
  }
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return '-';
  if (ageMs < 1000) return `${ageMs}ms`;
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m`;
  return `${(ageMs / 3_600_000).toFixed(1)}h`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function formatTimestamp(ts: string | number): string {
  try {
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    return d.toLocaleTimeString();
  } catch {
    return String(ts);
  }
}

function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    lines.push(remaining.substring(0, width));
    remaining = remaining.substring(width);
  }
  return lines;
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function parseJsonOutput(stdout: string): any {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Find the JSON object/array boundaries (handles prefix AND suffix noise)
    const jsonStart = trimmed.indexOf('{');
    const jsonArrayStart = trimmed.indexOf('[');
    const start = jsonStart === -1
      ? jsonArrayStart
      : jsonArrayStart === -1
        ? jsonStart
        : Math.min(jsonStart, jsonArrayStart);
    if (start >= 0) {
      const closer = trimmed[start] === '{' ? '}' : ']';
      const end = trimmed.lastIndexOf(closer);
      if (end > start) {
        try {
          return JSON.parse(trimmed.substring(start, end + 1));
        } catch {
          // ignore
        }
      }
    }
  }
  return null;
}

function printHelp(): void {
  console.log(`
task-status — Interactive OpenClaw session monitor

USAGE
  npm run task-status [-- OPTIONS]

MODES
  (default)             Interactive TUI — arrow keys to navigate, Enter for detail
  --json                Non-interactive JSON output (pipe-friendly)

OPTIONS
  --agent <id>          Filter by agent ID
  -n, --messages <N>    Messages to show in detail view (default: 50)
  --interval <sec>      Auto-refresh interval (default: 5)
  --help, -h            Show this help

INTERACTIVE KEYS
  Session list:
    ↑/↓ or j/k          Move cursor
    Enter                Open session detail
    Home/g               Jump to top
    End                  Jump to bottom
    r                    Refresh now
    q / Ctrl-C           Quit

  Session detail (message list):
    ↑/↓ or j/k           Navigate messages
    Enter                 View full message content
    Home/g / End          Jump to first/last message
    ←/Esc/Backspace/q     Back to session list
    r                     Refresh now

  Message view:
    ↑/↓ or j/k           Scroll line by line
    PgUp/PgDn/Space       Scroll by page
    Home/g / End          Jump to top/bottom
    ←/Esc/Backspace/q     Back to message list

EXAMPLES
  npm run task-status                         Interactive TUI
  npm run task-status -- --agent main         Filter to one agent
  npm run task-status -- -n 30                Show last 30 messages in detail
  npm run task-status -- --json               Pipe-friendly JSON
  npm run task-status -- --json | jq .        Process with jq
`.trim());
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const opts: AppOptions = {
    agentFilter: getArgValue(args, '--agent'),
    messageCount: parseInt(getArgValue(args, '-n') ?? getArgValue(args, '--messages') ?? '50', 10),
    refreshIntervalSec: parseInt(getArgValue(args, '--interval') ?? '5', 10),
    openclawHome: process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw'),
    openclawBin: process.env.OPENCLAW_BIN || 'openclaw',
    thresholdMs: parseInt(process.env.SESSION_ALIVE_THRESHOLD_MS || String(24 * 60 * 60 * 1000), 10),
  };

  const jsonOutput = args.includes('--json');
  const isTTY = process.stdout.isTTY && process.stdin.isTTY;

  // Non-interactive: --json flag or piped stdout
  if (jsonOutput || !isTTY) {
    const entries = await collectEntries(opts);
    printBatch(entries, jsonOutput);
    return;
  }

  // Interactive TUI
  const tui = new InteractiveTUI(opts);
  await tui.start();
}

main().catch((error) => {
  process.stdout.write(ansi.showCursor);
  console.error('Error:', error.message || error);
  process.exit(1);
});
