/**
 * Session Status Resolver Tests
 *
 * Tests the deriveState truth table and resolver integration.
 */

import { deriveState } from '../src/monitoring/session-status-resolver';
import type { JsonlAnalysis } from '../src/monitoring/types';

describe('deriveState', () => {
  const baseAnalysis: JsonlAnalysis = {
    lastMessageRole: null,
    lastStopReason: null,
    lastErrorMessage: null,
    toolCallCount: 0,
    messageCount: 0,
    model: null,
    provider: null,
  };

  describe('dead state', () => {
    it('returns dead when not alive, no analysis', () => {
      expect(deriveState(false, null)).toBe('dead');
    });

    it('trusts JSONL over age when not alive but JSONL shows active work', () => {
      // alive=false but assistant with no stop reason → JSONL says 'active' → trust JSONL
      expect(deriveState(false, { ...baseAnalysis, lastMessageRole: 'assistant' })).toBe('active');
    });

    it('trusts JSONL over age when not alive but toolResult present', () => {
      // alive=false but toolResult → JSONL says 'active' → trust JSONL
      expect(deriveState(false, {
        ...baseAnalysis,
        lastMessageRole: 'toolResult',
      })).toBe('active');
    });

    it('returns dead when not alive and JSONL shows non-active state', () => {
      // alive=false, assistant + stop='stop' → JSONL says 'completed' → not in activeStates → 'dead'
      expect(deriveState(false, {
        ...baseAnalysis,
        lastMessageRole: 'assistant',
        lastStopReason: 'stop',
      })).toBe('dead');
    });
  });

  describe('idle state', () => {
    it('returns idle when alive but no analysis', () => {
      expect(deriveState(true, null)).toBe('idle');
    });

    it('returns idle when alive with analysis but no lastMessageRole', () => {
      expect(deriveState(true, baseAnalysis)).toBe('idle');
    });
  });

  describe('errored state', () => {
    it('returns errored when assistant + error stop reason', () => {
      expect(deriveState(true, {
        ...baseAnalysis,
        lastMessageRole: 'assistant',
        lastStopReason: 'error',
        lastErrorMessage: 'Rate limit exceeded',
      })).toBe('errored');
    });
  });

  describe('completed state', () => {
    it('returns completed when assistant + stop reason', () => {
      expect(deriveState(true, {
        ...baseAnalysis,
        lastMessageRole: 'assistant',
        lastStopReason: 'stop',
      })).toBe('completed');
    });
  });

  describe('tool_calling state', () => {
    it('returns tool_calling when assistant + toolUse stop reason', () => {
      expect(deriveState(true, {
        ...baseAnalysis,
        lastMessageRole: 'assistant',
        lastStopReason: 'toolUse',
        toolCallCount: 2,
      })).toBe('tool_calling');
    });
  });

  describe('active state', () => {
    it('returns active when toolResult is last message', () => {
      expect(deriveState(true, {
        ...baseAnalysis,
        lastMessageRole: 'toolResult',
      })).toBe('active');
    });

    it('returns active when assistant has no stop reason (still generating)', () => {
      expect(deriveState(true, {
        ...baseAnalysis,
        lastMessageRole: 'assistant',
        lastStopReason: null,
      })).toBe('active');
    });
  });

  describe('waiting state', () => {
    it('returns waiting when user is last message', () => {
      expect(deriveState(true, {
        ...baseAnalysis,
        lastMessageRole: 'user',
      })).toBe('waiting');
    });
  });

  describe('full truth table', () => {
    const cases: Array<{
      alive: boolean;
      role: JsonlAnalysis['lastMessageRole'];
      stop: JsonlAnalysis['lastStopReason'];
      expected: string;
    }> = [
      { alive: false, role: null, stop: null, expected: 'dead' },
      { alive: false, role: 'assistant', stop: 'stop', expected: 'dead' },  // completed → not in activeStates → dead
      { alive: false, role: 'toolResult', stop: null, expected: 'active' }, // JSONL shows active work → trust it
      { alive: true, role: null, stop: null, expected: 'idle' },
      { alive: true, role: 'assistant', stop: 'error', expected: 'errored' },
      { alive: true, role: 'assistant', stop: 'stop', expected: 'completed' },
      { alive: true, role: 'assistant', stop: 'toolUse', expected: 'tool_calling' },
      { alive: true, role: 'assistant', stop: null, expected: 'active' },
      { alive: true, role: 'toolResult', stop: null, expected: 'active' },
      { alive: true, role: 'toolResult', stop: 'toolUse', expected: 'active' },
      { alive: true, role: 'user', stop: null, expected: 'waiting' },
      { alive: true, role: 'user', stop: 'stop', expected: 'waiting' },
    ];

    for (const { alive, role, stop, expected } of cases) {
      it(`alive=${alive}, role=${role}, stop=${stop} → ${expected}`, () => {
        const analysis = role !== null ? { ...baseAnalysis, lastMessageRole: role, lastStopReason: stop } : null;
        // When alive=true and role=null, we pass the base analysis (which has null role)
        const finalAnalysis = alive && role === null ? baseAnalysis : analysis;
        const result = deriveState(alive, finalAnalysis);
        expect(result).toBe(expected);
      });
    }
  });
});
