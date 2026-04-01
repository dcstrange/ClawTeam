/**
 * OpenClaw Session CLI Client Tests
 *
 * sendToSession uses spawn (fire-and-forget with grace period):
 *   - Spawns CLI detached, waits 3s for immediate failures
 *   - If process is still alive after grace period → delivery assumed successful
 *   - If process errors/exits with non-zero within grace period → failure
 *
 * isSessionAlive uses execFileAsync (quick query).
 */

import { EventEmitter } from 'node:events';
import { OpenClawSessionCliClient } from '../src/providers/openclaw/openclaw-session-cli';
import pino from 'pino';

// --- Build a fake ChildProcess for spawn ---
function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    unref: jest.Mock;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = jest.fn();
  child.pid = 12345;
  return child;
}

let fakeChild: ReturnType<typeof createFakeChild>;

jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));

jest.mock('node:util', () => {
  const actual = jest.requireActual('node:util');
  return {
    ...actual,
    promisify: (fn: Function) => fn,
  };
});

jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn().mockReturnValue([]),
  renameSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';

const mockedSpawn = spawn as unknown as jest.Mock;
const mockedExecFile = execFile as unknown as jest.Mock;
const mockFsExistsSync = fs.existsSync as unknown as jest.Mock;
const mockFsReadFileSync = fs.readFileSync as unknown as jest.Mock;

const logger = pino({ level: 'silent' });

function mockSessionsJson(sessionKey: string, sessionId: string) {
  mockFsExistsSync.mockReturnValue(true);
  mockFsReadFileSync.mockReturnValue(
    JSON.stringify({ [sessionKey]: { sessionId } }),
  );
}

describe('OpenClawSessionCliClient', () => {
  let client: OpenClawSessionCliClient;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockedSpawn.mockImplementation(() => {
      fakeChild = createFakeChild();
      return fakeChild;
    });
    client = new OpenClawSessionCliClient('main', logger, {
      openclawBin: '/usr/bin/openclaw',
      sessionAliveThresholdMs: 24 * 60 * 60 * 1000,
      openclawHome: '/mock/.openclaw',
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('sendToSession()', () => {
    it('spawns CLI with real session UUID (no --agent flag)', async () => {
      mockSessionsJson('agent:bob:main', 'uuid-bob-main');

      const promise = client.sendToSession('agent:bob:main', 'Hello Bob');

      // Advance past grace period — process still alive → success
      jest.advanceTimersByTime(3_000);
      const result = await promise;

      expect(result).toBe(true);
      expect(mockedSpawn).toHaveBeenCalledWith(
        '/usr/bin/openclaw',
        ['agent', '--session-id', 'uuid-bob-main', '--message', 'Hello Bob', '--json'],
        expect.objectContaining({ detached: true }),
      );
      const spawnArgs = mockedSpawn.mock.calls[0]![1] as unknown as string[];
      expect(spawnArgs).not.toContain('--agent');
    });

    it('returns true after grace period (process still running)', async () => {
      mockSessionsJson('agent:bob:main', 'uuid-bob');

      const promise = client.sendToSession('agent:bob:main', 'test');
      jest.advanceTimersByTime(3_000);

      expect(await promise).toBe(true);
      expect(fakeChild.unref).toHaveBeenCalled();
    });

    it('returns true when process exits cleanly within grace period', async () => {
      mockSessionsJson('agent:bob:main', 'uuid-bob');

      const promise = client.sendToSession('agent:bob:main', 'test');
      // Process exits with code 0 before grace period ends (fast task)
      fakeChild.emit('exit', 0);

      expect(await promise).toBe(true);
    });

    it('returns false for invalid session key format', async () => {
      const result = await client.sendToSession('invalid-key', 'test');
      expect(result).toBe(false);
      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it('returns false when sessionId not found in sessions.json', async () => {
      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue('{}');

      const result = await client.sendToSession('agent:bob:main', 'test');
      expect(result).toBe(false);
      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it('returns false when spawn emits error', async () => {
      mockSessionsJson('agent:bob:main', 'uuid-bob');

      const promise = client.sendToSession('agent:bob:main', 'test');
      fakeChild.emit('error', new Error('ENOENT'));

      expect(await promise).toBe(false);
    });

    it('returns false when process exits with non-zero code within grace period', async () => {
      mockSessionsJson('agent:bob:main', 'uuid-bob');

      const promise = client.sendToSession('agent:bob:main', 'test');
      fakeChild.emit('exit', 1);

      expect(await promise).toBe(false);
    });

    it('unrefs child after grace period (fire-and-forget)', async () => {
      mockSessionsJson('agent:bob:main', 'uuid-bob');

      const promise = client.sendToSession('agent:bob:main', 'test');
      jest.advanceTimersByTime(3_000);

      await promise;
      expect(fakeChild.unref).toHaveBeenCalledTimes(1);
    });

    it('looks up correct agentId from session key', async () => {
      mockSessionsJson('agent:alice:subagent:abc-123', 'uuid-alice-sub');

      const promise = client.sendToSession('agent:alice:subagent:abc-123', 'test');
      jest.advanceTimersByTime(3_000);

      expect(await promise).toBe(true);
      expect(mockFsExistsSync).toHaveBeenCalledWith(
        expect.stringContaining('/agents/alice/sessions/sessions.json'),
      );
    });
  });

  describe('sendToMainSession()', () => {
    it('sends to agent:<mainAgentId>:main via spawn', async () => {
      mockSessionsJson('agent:main:main', 'uuid-main');

      const promise = client.sendToMainSession('Hello main');
      jest.advanceTimersByTime(3_000);

      expect(await promise).toBe(true);
      expect(mockedSpawn).toHaveBeenCalledWith(
        '/usr/bin/openclaw',
        ['agent', '--session-id', 'uuid-main', '--message', 'Hello main', '--json'],
        expect.objectContaining({ detached: true }),
      );
    });
  });

  describe('isSessionAlive()', () => {
    it('returns true for recently active session', async () => {
      mockedExecFile.mockResolvedValue({
        stdout: JSON.stringify({
          sessions: [
            { key: 'agent:bob:main', updatedAt: Date.now() - 1000, ageMs: 1000 },
          ],
        }),
        stderr: '',
      });

      const result = await client.isSessionAlive('agent:bob:main');
      expect(result).toBe(true);
    });

    it('returns false for old session', async () => {
      const oldAge = 48 * 60 * 60 * 1000;
      mockedExecFile.mockResolvedValue({
        stdout: JSON.stringify({
          sessions: [
            { key: 'agent:bob:main', updatedAt: Date.now() - oldAge, ageMs: oldAge },
          ],
        }),
        stderr: '',
      });

      const result = await client.isSessionAlive('agent:bob:main');
      expect(result).toBe(false);
    });

    it('returns false for unknown session', async () => {
      mockedExecFile.mockResolvedValue({
        stdout: JSON.stringify({ sessions: [] }),
        stderr: '',
      });

      const result = await client.isSessionAlive('agent:unknown:main');
      expect(result).toBe(false);
    });

    it('returns false when CLI fails', async () => {
      mockedExecFile.mockRejectedValue(new Error('Connection refused'));

      const result = await client.isSessionAlive('agent:bob:main');
      expect(result).toBe(false);
    });

    it('returns false for invalid session key', async () => {
      const result = await client.isSessionAlive('invalid');
      expect(result).toBe(false);
    });
  });
});
