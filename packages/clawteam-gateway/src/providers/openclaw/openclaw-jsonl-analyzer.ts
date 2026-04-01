/**
 * JSONL File Analyzer
 *
 * Reads the tail of OpenClaw session JSONL files to extract the latest
 * session state information. Only reads the last ~64KB to avoid loading
 * entire conversation histories into memory.
 *
 * OpenClaw JSONL format uses event wrappers (one JSON object per line):
 * - {"type":"message","message":{"role":"assistant","content":[...],"stopReason":"toolUse"}}
 * - {"type":"message","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
 * - {"type":"session", ...}  (non-message events, skipped)
 * - {"type":"model_change", ...}  (non-message events, skipped)
 *
 * Also supports flat format (role at top level) for backward compatibility.
 *
 * Content block types: "text", "toolCall" (or "tool_use"), "thinking"
 * Roles: "user", "assistant", "toolResult"
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JsonlAnalysis } from '../../monitoring/types.js';

/** How many bytes to read from the tail of the JSONL file */
const TAIL_BYTES = 64 * 1024; // 64KB

/**
 * Analyze the tail of a session JSONL file.
 *
 * @param jsonlPath - Absolute path to the .jsonl file
 * @returns Analysis results, or null if file doesn't exist or can't be read
 */
export function analyzeTail(jsonlPath: string): JsonlAnalysis | null {
  try {
    if (!fs.existsSync(jsonlPath)) {
      return null;
    }

    const stat = fs.statSync(jsonlPath);
    if (stat.size === 0) {
      return null;
    }

    // Read from the tail of the file
    const readSize = Math.min(stat.size, TAIL_BYTES);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
    } finally {
      fs.closeSync(fd);
    }

    const text = buffer.toString('utf-8');
    const lines = text.split('\n').filter((line) => line.trim().length > 0);

    // If we started mid-line (reading from offset > 0), drop the first partial line
    if (stat.size > TAIL_BYTES && lines.length > 0) {
      lines.shift();
    }

    if (lines.length === 0) {
      return null;
    }

    return parseLines(lines);
  } catch {
    return null;
  }
}

/**
 * Build the full path to a session's JSONL file.
 *
 * @param openclawHome - OpenClaw home directory (e.g., ~/.openclaw)
 * @param agentId - Agent identifier
 * @param sessionId - Real session UUID
 * @returns Absolute path to the JSONL file
 */
export function buildJsonlPath(openclawHome: string, agentId: string, sessionId: string): string {
  return path.join(openclawHome, 'agents', agentId, 'sessions', `${sessionId}.jsonl`);
}

/**
 * Unwrap the OpenClaw event envelope if present.
 * Real JSONL lines: {"type":"message","message":{"role":"assistant",...}}
 * Flat format:      {"role":"assistant",...}
 *
 * Returns the inner message object, or null if this line is not a message.
 */
function unwrapMessage(obj: any): any | null {
  // Event-wrapped format: { type: "message", message: { role, content, ... } }
  if (obj.type === 'message' && obj.message) {
    return obj.message;
  }
  // Non-message events (session, model_change, thinking_level_change, etc.)
  if (obj.type && !obj.role) {
    return null;
  }
  // Flat format (backward compat): { role, content, ... }
  if (obj.role) {
    return obj;
  }
  return null;
}

/**
 * Parse an array of JSONL lines and extract analysis results.
 */
function parseLines(lines: string[]): JsonlAnalysis {
  const result: JsonlAnalysis = {
    lastMessageRole: null,
    lastStopReason: null,
    lastErrorMessage: null,
    toolCallCount: 0,
    messageCount: 0,
    model: null,
    provider: null,
  };

  for (const line of lines) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // Skip malformed lines
    }

    // Unwrap event envelope
    const msg = unwrapMessage(obj);
    if (!msg) {
      continue; // Skip non-message events
    }

    result.messageCount++;

    const role = msg.role;
    if (!role) continue;

    if (role === 'assistant') {
      result.lastMessageRole = 'assistant';

      // Extract stop reason
      const stopReason = normalizeStopReason(msg.stopReason || msg.stop_reason);
      if (stopReason) {
        result.lastStopReason = stopReason;
      }

      // Extract model/provider
      if (msg.model) result.model = msg.model;
      if (msg.provider) result.provider = msg.provider;

      // Count tool call blocks in content (both "tool_use" and "toolCall" formats)
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use' || block.type === 'toolCall') {
            result.toolCallCount++;
          }
        }
      }

      // Check for error messages
      if (stopReason === 'error') {
        result.lastErrorMessage = extractErrorMessage(msg);
      }
    } else if (role === 'toolResult') {
      // Direct toolResult role (OpenClaw format)
      result.lastMessageRole = 'toolResult';
      result.lastStopReason = null;
      result.lastErrorMessage = null;
    } else if (role === 'user') {
      // Check if this is a tool_result message (flat format backward compat)
      if (Array.isArray(msg.content)) {
        const hasToolResult = msg.content.some(
          (block: any) => block.type === 'tool_result',
        );
        result.lastMessageRole = hasToolResult ? 'toolResult' : 'user';
      } else {
        result.lastMessageRole = 'user';
      }
      // Reset stop reason when new user/tool message comes in
      result.lastStopReason = null;
      result.lastErrorMessage = null;
    }
  }

  return result;
}

/**
 * Normalize various stop_reason formats to our standard enum.
 */
function normalizeStopReason(raw: string | undefined): 'stop' | 'toolUse' | 'error' | null {
  if (!raw) return null;

  switch (raw) {
    case 'end_turn':
    case 'stop':
    case 'stop_sequence':
    case 'max_tokens':
      return 'stop';
    case 'tool_use':
    case 'toolUse':
      return 'toolUse';
    case 'error':
      return 'error';
    default:
      return null;
  }
}

/** A structured content block from a message, for full display */
export interface ContentBlock {
  type: 'text' | 'thinking' | 'toolCall' | 'toolResult' | 'other';
  text?: string;
  toolName?: string;
  toolArgs?: any;
  exitCode?: number | null;
  durationMs?: number | null;
  isError?: boolean;
}

/** A parsed message from the JSONL file, used for detail display */
export interface ParsedMessage {
  role: string;
  /** Normalized: 'user' | 'assistant' | 'toolResult' | 'system' | raw */
  displayRole: string;
  stopReason: string | null;
  /** Summarized content: text preview, tool names, tool result snippets */
  summary: string;
  model: string | null;
  /** tool_use names in this message */
  toolNames: string[];
  /** Raw timestamp if present */
  timestamp: string | null;
  /** Structured content blocks for full message view */
  contentBlocks: ContentBlock[];
  /** Token usage stats (assistant messages) */
  usage: { input: number; output: number; cacheRead?: number } | null;
  /** Provider name */
  provider: string | null;
}

/**
 * Read the last N messages from a JSONL file, parsed into display-friendly format.
 *
 * @param jsonlPath - Absolute path to the .jsonl file
 * @param count - Number of messages to return (default 50)
 * @returns Array of parsed messages (newest last), or empty array
 */
export function readLastMessages(jsonlPath: string, count: number = 50): ParsedMessage[] {
  try {
    if (!fs.existsSync(jsonlPath)) return [];

    const stat = fs.statSync(jsonlPath);
    if (stat.size === 0) return [];

    // Read a generous tail to ensure we get enough messages
    // Each message can be large (tool results), so read more than TAIL_BYTES
    const readSize = Math.min(stat.size, 512 * 1024); // 512KB
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
    } finally {
      fs.closeSync(fd);
    }

    const text = buffer.toString('utf-8');
    const lines = text.split('\n').filter((line) => line.trim().length > 0);

    // Drop first partial line if reading from middle
    if (stat.size > readSize && lines.length > 0) {
      lines.shift();
    }

    // Parse all lines, then take last N
    const messages: ParsedMessage[] = [];
    for (const line of lines) {
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      // Unwrap event envelope
      const msg = unwrapMessage(obj);
      if (!msg) continue;

      const role = msg.role;
      if (!role) continue;

      messages.push(parseMessageForDisplay(msg));
    }

    return messages.slice(-count);
  } catch {
    return [];
  }
}

/**
 * Parse a single message object (already unwrapped) into display-friendly format.
 */
function parseMessageForDisplay(obj: any): ParsedMessage {
  const role = obj.role || 'unknown';
  let displayRole = role;
  let summary = '';
  const toolNames: string[] = [];
  const contentBlocks: ContentBlock[] = [];
  const stopReason = normalizeStopReason(obj.stopReason || obj.stop_reason);

  // Extract usage stats
  const usage = obj.usage
    ? { input: obj.usage.input || 0, output: obj.usage.output || 0, cacheRead: obj.usage.cacheRead }
    : null;

  if (role === 'toolResult') {
    displayRole = 'toolResult';
    const toolName = obj.toolName || null;
    const details = obj.details || {};
    let fullText = '';
    if (Array.isArray(obj.content)) {
      const texts = obj.content.filter((b: any) => b.type === 'text').map((b: any) => b.text || '');
      fullText = texts.join('\n');
    } else if (typeof obj.content === 'string') {
      fullText = obj.content;
    }
    summary = toolName ? `[${toolName}] ${truncateStr(fullText, 120)}` : truncateStr(fullText, 120);
    contentBlocks.push({
      type: 'toolResult',
      text: fullText,
      toolName: toolName ?? undefined,
      exitCode: details.exitCode ?? null,
      durationMs: details.durationMs ?? null,
      isError: obj.isError ?? false,
    });
  } else if (role === 'user' && Array.isArray(obj.content)) {
    const hasToolResult = obj.content.some((b: any) => b.type === 'tool_result');
    if (hasToolResult) {
      displayRole = 'toolResult';
      const results = obj.content.filter((b: any) => b.type === 'tool_result');
      const previews = results.map((r: any) => {
        const content = typeof r.content === 'string'
          ? r.content
          : Array.isArray(r.content)
            ? r.content.map((c: any) => c.text || '').join('')
            : '';
        contentBlocks.push({ type: 'toolResult', text: content, isError: r.is_error ?? false });
        return truncateStr(content, 80);
      });
      summary = previews.join(' | ');
    } else {
      for (const block of obj.content) {
        if (block.type === 'text' && block.text) {
          contentBlocks.push({ type: 'text', text: block.text });
        }
      }
      const texts = contentBlocks.filter((b) => b.type === 'text').map((b) => b.text || '');
      summary = truncateStr(texts.join(' '), 120);
    }
  } else if (role === 'user' && typeof obj.content === 'string') {
    summary = truncateStr(obj.content, 120);
    contentBlocks.push({ type: 'text', text: obj.content });
  } else if (role === 'assistant' && Array.isArray(obj.content)) {
    const parts: string[] = [];
    for (const block of obj.content) {
      if (block.type === 'text' && block.text) {
        parts.push(truncateStr(block.text, 80));
        contentBlocks.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use' || block.type === 'toolCall') {
        const name = block.name || 'unknown';
        toolNames.push(name);
        parts.push(`[tool: ${name}]`);
        contentBlocks.push({
          type: 'toolCall',
          toolName: name,
          toolArgs: block.arguments || block.input || null,
        });
      } else if (block.type === 'thinking' && (block.thinking || block.text)) {
        contentBlocks.push({ type: 'thinking', text: block.thinking || block.text });
      }
    }
    summary = parts.join(' ');
  } else if (role === 'assistant' && typeof obj.content === 'string') {
    summary = truncateStr(obj.content, 120);
    contentBlocks.push({ type: 'text', text: obj.content });
  }

  return {
    role,
    displayRole,
    stopReason: stopReason ?? (obj.stopReason || obj.stop_reason || null),
    summary: summary || '(empty)',
    model: obj.model || null,
    toolNames,
    timestamp: obj.timestamp || obj.createdAt || null,
    contentBlocks,
    usage,
    provider: obj.provider || null,
  };
}

function truncateStr(str: string, maxLen: number): string {
  const clean = str.replace(/\n/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen - 3) + '...';
}

/**
 * Extract error message from an assistant message object.
 */
function extractErrorMessage(obj: any): string | null {
  // Check content blocks for error text
  if (Array.isArray(obj.content)) {
    for (const block of obj.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text.substring(0, 500);
      }
    }
  }

  // Check top-level error field
  if (obj.error) {
    if (typeof obj.error === 'string') return obj.error.substring(0, 500);
    if (typeof obj.error.message === 'string') return obj.error.message.substring(0, 500);
  }

  return null;
}
