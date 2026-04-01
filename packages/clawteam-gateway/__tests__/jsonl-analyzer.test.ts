/**
 * JSONL Analyzer Tests
 *
 * Tests JSONL tail parsing: various stopReasons, tool call counting,
 * empty/missing files, large file tail reading, malformed lines.
 *
 * Tests both flat format (role at top level) and the real OpenClaw
 * event-wrapped format (type: "message", message: { role, ... }).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeTail, buildJsonlPath, readLastMessages } from '../src/providers/openclaw/openclaw-jsonl-analyzer';

describe('analyzeTail', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-analyzer-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJsonl(filename: string, lines: any[]): string {
    const filePath = path.join(tmpDir, filename);
    const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it('returns null for non-existent file', () => {
    const result = analyzeTail(path.join(tmpDir, 'missing.jsonl'));
    expect(result).toBeNull();
  });

  it('returns null for empty file', () => {
    const filePath = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(filePath, '');
    expect(analyzeTail(filePath)).toBeNull();
  });

  it('parses a single user message', () => {
    const filePath = writeJsonl('single-user.jsonl', [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ]);

    const result = analyzeTail(filePath);
    expect(result).not.toBeNull();
    expect(result!.lastMessageRole).toBe('user');
    expect(result!.messageCount).toBe(1);
    expect(result!.lastStopReason).toBeNull();
  });

  it('parses assistant message with end_turn stop reason', () => {
    const filePath = writeJsonl('end-turn.jsonl', [
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
        stopReason: 'end_turn',
        model: 'claude-3-opus',
      },
    ]);

    const result = analyzeTail(filePath);
    expect(result).not.toBeNull();
    expect(result!.lastMessageRole).toBe('assistant');
    expect(result!.lastStopReason).toBe('stop');
    expect(result!.model).toBe('claude-3-opus');
    expect(result!.messageCount).toBe(2);
  });

  it('parses assistant message with tool_use stop reason', () => {
    const filePath = writeJsonl('tool-use.jsonl', [
      { role: 'user', content: [{ type: 'text', text: 'Read file' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will read that file.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/a' } },
        ],
        stopReason: 'tool_use',
      },
    ]);

    const result = analyzeTail(filePath);
    expect(result!.lastMessageRole).toBe('assistant');
    expect(result!.lastStopReason).toBe('toolUse');
    expect(result!.toolCallCount).toBe(1);
  });

  it('counts multiple tool_use blocks', () => {
    const filePath = writeJsonl('multi-tool.jsonl', [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: {} },
          { type: 'tool_use', id: 't2', name: 'Write', input: {} },
          { type: 'tool_use', id: 't3', name: 'Bash', input: {} },
        ],
        stopReason: 'tool_use',
      },
    ]);

    const result = analyzeTail(filePath);
    expect(result!.toolCallCount).toBe(3);
    expect(result!.lastStopReason).toBe('toolUse');
  });

  it('parses tool_result as toolResult role', () => {
    const filePath = writeJsonl('tool-result.jsonl', [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        stopReason: 'tool_use',
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }],
      },
    ]);

    const result = analyzeTail(filePath);
    expect(result!.lastMessageRole).toBe('toolResult');
    // stopReason should be reset when user/tool message arrives
    expect(result!.lastStopReason).toBeNull();
  });

  it('parses error stop reason', () => {
    const filePath = writeJsonl('error.jsonl', [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Something went wrong' }],
        stopReason: 'error',
      },
    ]);

    const result = analyzeTail(filePath);
    expect(result!.lastMessageRole).toBe('assistant');
    expect(result!.lastStopReason).toBe('error');
    expect(result!.lastErrorMessage).toBe('Something went wrong');
  });

  it('extracts error from error field', () => {
    const filePath = writeJsonl('error-field.jsonl', [
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        error: { message: 'Rate limit exceeded' },
      },
    ]);

    const result = analyzeTail(filePath);
    expect(result!.lastStopReason).toBe('error');
    expect(result!.lastErrorMessage).toBe('Rate limit exceeded');
  });

  it('handles stop_reason with underscore format', () => {
    const filePath = writeJsonl('underscore.jsonl', [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        stop_reason: 'end_turn',
      },
    ]);

    const result = analyzeTail(filePath);
    expect(result!.lastStopReason).toBe('stop');
  });

  it('handles max_tokens stop reason as stop', () => {
    const filePath = writeJsonl('max-tokens.jsonl', [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Truncated...' }],
        stopReason: 'max_tokens',
      },
    ]);

    const result = analyzeTail(filePath);
    expect(result!.lastStopReason).toBe('stop');
  });

  it('skips malformed JSON lines gracefully', () => {
    const filePath = path.join(tmpDir, 'malformed.jsonl');
    const content = [
      '{"role":"user","content":[{"type":"text","text":"Hi"}]}',
      'NOT JSON AT ALL',
      '{"role":"assistant","content":[{"type":"text","text":"Hello"}],"stopReason":"end_turn"}',
    ].join('\n') + '\n';
    fs.writeFileSync(filePath, content);

    const result = analyzeTail(filePath);
    expect(result).not.toBeNull();
    expect(result!.lastMessageRole).toBe('assistant');
    expect(result!.lastStopReason).toBe('stop');
    expect(result!.messageCount).toBe(2); // malformed line skipped
  });

  it('extracts model and provider', () => {
    const filePath = writeJsonl('model.jsonl', [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi' }],
        stopReason: 'end_turn',
        model: 'claude-3.5-sonnet',
        provider: 'anthropic',
      },
    ]);

    const result = analyzeTail(filePath);
    expect(result!.model).toBe('claude-3.5-sonnet');
    expect(result!.provider).toBe('anthropic');
  });

  it('handles conversation with multiple turns correctly', () => {
    const filePath = writeJsonl('multi-turn.jsonl', [
      { role: 'user', content: [{ type: 'text', text: 'Step 1' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        stopReason: 'tool_use',
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done!' }],
        stopReason: 'end_turn',
        model: 'claude-3-opus',
      },
    ]);

    const result = analyzeTail(filePath);
    expect(result!.lastMessageRole).toBe('assistant');
    expect(result!.lastStopReason).toBe('stop');
    expect(result!.toolCallCount).toBe(1);
    expect(result!.messageCount).toBe(4);
    expect(result!.model).toBe('claude-3-opus');
  });

  it('skips non-message event lines', () => {
    const filePath = writeJsonl('no-role.jsonl', [
      { type: 'system', content: 'System prompt' },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ]);

    const result = analyzeTail(filePath);
    expect(result!.lastMessageRole).toBe('user');
    expect(result!.messageCount).toBe(1); // system event skipped
  });

  it('reads only tail of large files', () => {
    const filePath = path.join(tmpDir, 'large.jsonl');
    // Write many lines to exceed 64KB
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(JSON.stringify({
        role: 'user',
        content: [{ type: 'text', text: `Message ${i} with some padding to make it longer ${'x'.repeat(50)}` }],
      }));
    }
    // Last line is an assistant message
    lines.push(JSON.stringify({
      role: 'assistant',
      content: [{ type: 'text', text: 'Final response' }],
      stopReason: 'end_turn',
    }));
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    const stat = fs.statSync(filePath);
    expect(stat.size).toBeGreaterThan(64 * 1024); // Confirm file is > 64KB

    const result = analyzeTail(filePath);
    expect(result).not.toBeNull();
    expect(result!.lastMessageRole).toBe('assistant');
    expect(result!.lastStopReason).toBe('stop');
    // messageCount should be less than total lines since we only read tail
    expect(result!.messageCount).toBeLessThan(2001);
    expect(result!.messageCount).toBeGreaterThan(0);
  });
});

describe('buildJsonlPath', () => {
  it('builds correct path', () => {
    const result = buildJsonlPath('/home/user/.openclaw', 'main', 'abc-123');
    expect(result).toBe('/home/user/.openclaw/agents/main/sessions/abc-123.jsonl');
  });
});

// ── Event-wrapped format tests (real OpenClaw JSONL format) ──────

describe('analyzeTail — event-wrapped format', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-wrapped-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJsonl(filename: string, lines: any[]): string {
    const filePath = path.join(tmpDir, filename);
    const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  /** Helper to wrap a message in the real event envelope */
  function wrapMsg(message: any): any {
    return {
      type: 'message',
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      message,
    };
  }

  it('parses event-wrapped user + assistant messages', () => {
    const filePath = writeJsonl('wrapped.jsonl', [
      { type: 'session', version: 3, id: 'test-session' },
      wrapMsg({ role: 'user', content: [{ type: 'text', text: 'Hello' }] }),
      wrapMsg({
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there!' }],
        stopReason: 'stop',
        model: 'glm-4.7',
        provider: 'zai',
      }),
    ]);

    const result = analyzeTail(filePath);
    expect(result).not.toBeNull();
    expect(result!.lastMessageRole).toBe('assistant');
    expect(result!.lastStopReason).toBe('stop');
    expect(result!.model).toBe('glm-4.7');
    expect(result!.provider).toBe('zai');
    expect(result!.messageCount).toBe(2); // session event skipped
  });

  it('handles toolCall content type (not tool_use)', () => {
    const filePath = writeJsonl('toolcall.jsonl', [
      wrapMsg({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me read the file' },
          { type: 'toolCall', id: 'call_abc', name: 'exec', arguments: { command: 'ls' } },
        ],
        stopReason: 'toolUse',
        model: 'glm-4.7',
      }),
    ]);

    const result = analyzeTail(filePath);
    expect(result!.lastMessageRole).toBe('assistant');
    expect(result!.lastStopReason).toBe('toolUse');
    expect(result!.toolCallCount).toBe(1);
  });

  it('handles direct toolResult role', () => {
    const filePath = writeJsonl('toolresult.jsonl', [
      wrapMsg({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_1', name: 'exec', arguments: {} }],
        stopReason: 'toolUse',
      }),
      wrapMsg({
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'exec',
        content: [{ type: 'text', text: 'command output here' }],
        isError: false,
      }),
    ]);

    const result = analyzeTail(filePath);
    expect(result!.lastMessageRole).toBe('toolResult');
    expect(result!.lastStopReason).toBeNull(); // reset on toolResult
    expect(result!.toolCallCount).toBe(1);
    expect(result!.messageCount).toBe(2);
  });

  it('skips non-message events (session, model_change, etc.)', () => {
    const filePath = writeJsonl('events.jsonl', [
      { type: 'session', version: 3, id: 'sess-1', timestamp: '2026-01-01T00:00:00Z' },
      { type: 'model_change', id: 'mc-1', provider: 'zai', modelId: 'glm-4.7' },
      { type: 'thinking_level_change', id: 'tlc-1', thinkingLevel: 'low' },
      wrapMsg({ role: 'user', content: [{ type: 'text', text: 'Hello' }] }),
    ]);

    const result = analyzeTail(filePath);
    expect(result!.messageCount).toBe(1); // only the user message counted
    expect(result!.lastMessageRole).toBe('user');
  });

  it('handles full real-world conversation flow', () => {
    const filePath = writeJsonl('real-flow.jsonl', [
      { type: 'session', version: 3, id: 'sess-1' },
      { type: 'model_change', id: 'mc-1', provider: 'zai', modelId: 'glm-4.7' },
      wrapMsg({ role: 'user', content: [{ type: 'text', text: 'Review the code' }] }),
      wrapMsg({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should read the file first' },
          { type: 'toolCall', id: 'call_1', name: 'Read', arguments: { path: '/src/index.ts' } },
        ],
        stopReason: 'toolUse',
        model: 'glm-4.7',
        provider: 'zai',
      }),
      wrapMsg({
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'Read',
        content: [{ type: 'text', text: 'import { foo } from "./bar"' }],
        isError: false,
      }),
      wrapMsg({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'The code looks fine' },
          { type: 'text', text: 'The code looks good. No issues found.' },
        ],
        stopReason: 'stop',
        model: 'glm-4.7',
        provider: 'zai',
      }),
    ]);

    const result = analyzeTail(filePath);
    expect(result!.lastMessageRole).toBe('assistant');
    expect(result!.lastStopReason).toBe('stop');
    expect(result!.toolCallCount).toBe(1);
    expect(result!.messageCount).toBe(4); // user + assistant + toolResult + assistant
    expect(result!.model).toBe('glm-4.7');
    expect(result!.provider).toBe('zai');
  });
});

describe('readLastMessages — event-wrapped format', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-readmsg-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJsonl(filename: string, lines: any[]): string {
    const filePath = path.join(tmpDir, filename);
    const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function wrapMsg(message: any): any {
    return {
      type: 'message',
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      message,
    };
  }

  it('reads messages from event-wrapped JSONL', () => {
    const filePath = writeJsonl('msgs.jsonl', [
      { type: 'session', version: 3, id: 'sess-1' },
      wrapMsg({ role: 'user', content: [{ type: 'text', text: 'Hello' }] }),
      wrapMsg({
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there!' }],
        stopReason: 'stop',
        model: 'glm-4.7',
      }),
    ]);

    const messages = readLastMessages(filePath, 10);
    expect(messages).toHaveLength(2);
    expect(messages[0].displayRole).toBe('user');
    expect(messages[0].summary).toContain('Hello');
    expect(messages[1].displayRole).toBe('assistant');
    expect(messages[1].summary).toContain('Hi there!');
    expect(messages[1].model).toBe('glm-4.7');
  });

  it('handles toolCall blocks and direct toolResult role', () => {
    const filePath = writeJsonl('tools.jsonl', [
      wrapMsg({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me check' },
          { type: 'toolCall', id: 'call_1', name: 'exec', arguments: { command: 'ls' } },
        ],
        stopReason: 'toolUse',
        model: 'glm-4.7',
      }),
      wrapMsg({
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'exec',
        content: [{ type: 'text', text: 'file1.ts file2.ts' }],
        isError: false,
      }),
    ]);

    const messages = readLastMessages(filePath, 10);
    expect(messages).toHaveLength(2);

    // Assistant with toolCall
    expect(messages[0].displayRole).toBe('assistant');
    expect(messages[0].toolNames).toEqual(['exec']);
    expect(messages[0].summary).toContain('[tool: exec]');
    expect(messages[0].stopReason).toBe('toolUse');

    // Direct toolResult
    expect(messages[1].displayRole).toBe('toolResult');
    expect(messages[1].summary).toContain('[exec]');
    expect(messages[1].summary).toContain('file1.ts');
  });

  it('skips non-message events', () => {
    const filePath = writeJsonl('skip.jsonl', [
      { type: 'session', version: 3, id: 'sess-1' },
      { type: 'model_change', provider: 'zai', modelId: 'glm-4.7' },
      wrapMsg({ role: 'user', content: [{ type: 'text', text: 'Hello' }] }),
    ]);

    const messages = readLastMessages(filePath, 10);
    expect(messages).toHaveLength(1);
    expect(messages[0].displayRole).toBe('user');
  });
});
