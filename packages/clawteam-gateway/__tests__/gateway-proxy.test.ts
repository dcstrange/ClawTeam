/**
 * Gateway Proxy Tests — Baseline for Provider Abstraction
 *
 * Tests the session key tracking logic in POST /gateway/tasks/:taskId/accept.
 * Current behavior: only overwrites tracking when existing key does NOT
 * start with 'agent:'. After Commit 6 this changes to "never overwrite
 * existing tracking".
 *
 * Also tests POST /gateway/track-session for explicit session tracking.
 *
 * Uses Fastify inject() for HTTP-level testing with mocked fetch().
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerGatewayRoutes } from '../src/gateway/gateway-proxy';
import { SessionTracker } from '../src/routing/session-tracker';
import pino from 'pino';

const logger = pino({ level: 'silent' });

// ── Mock global fetch ──────────────────────────────────────────

let fetchMock: jest.SpyInstance;

/** Create a minimal mock Response for proxyFetch */
function mockFetchResponse(data: any, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(data)),
    json: () => Promise.resolve(data),
  } as Response);
}

// ── Test Suite ─────────────────────────────────────────────────

describe('Gateway Proxy — session key tracking', () => {
  let server: FastifyInstance;
  let sessionTracker: SessionTracker;

  beforeEach(async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(
      () => mockFetchResponse({ success: true, data: {} }),
    );

    sessionTracker = new SessionTracker();

    server = Fastify({ logger: false });
    registerGatewayRoutes(server, {
      clawteamApiUrl: 'http://api:3000',
      clawteamApiKey: 'test-key',
      clawteamBotId: 'bot-test',
      sessionTracker,
      logger,
    });

    await server.ready();
  });

  afterEach(async () => {
    fetchMock.mockRestore();
    await server.close();
  });

  describe('POST /gateway/tasks/:taskId/accept', () => {
    it('tracks session key when no existing tracking', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/gateway/tasks/t1/accept',
        payload: { executorSessionKey: 'agent:bot:sub:uuid1' },
      });

      expect(response.statusCode).toBe(200);
      expect(sessionTracker.getSessionForTask('t1')).toBe('agent:bot:sub:uuid1');
    });

    it('preserves existing agent: tracking (does not overwrite)', async () => {
      // Pre-existing tracking set by plugin
      sessionTracker.track('t2', 'agent:bot:sub:existing');

      const response = await server.inject({
        method: 'POST',
        url: '/gateway/tasks/t2/accept',
        payload: { executorSessionKey: 'agent:bot:sub:new' },
      });

      expect(response.statusCode).toBe(200);
      // Original agent: key preserved — current startsWith('agent:') logic
      expect(sessionTracker.getSessionForTask('t2')).toBe('agent:bot:sub:existing');
    });

    it('overwrites non-agent: tracking with new key (current behavior)', async () => {
      // Non-agent key (unusual but tests current startsWith check)
      sessionTracker.track('t3', 'http-session-old');

      const response = await server.inject({
        method: 'POST',
        url: '/gateway/tasks/t3/accept',
        payload: { executorSessionKey: 'agent:bot:sub:new' },
      });

      expect(response.statusCode).toBe(200);
      // Non-agent: existing gets overwritten by current logic
      expect(sessionTracker.getSessionForTask('t3')).toBe('agent:bot:sub:new');
    });

    it('does not track when no executorSessionKey in body', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/gateway/tasks/t4/accept',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(sessionTracker.getSessionForTask('t4')).toBeUndefined();
    });

    it('fills executorSessionKey from tracker when missing in body', async () => {
      // Pre-tracked by plugin
      sessionTracker.track('t5', 'agent:bot:sub:tracked');

      const response = await server.inject({
        method: 'POST',
        url: '/gateway/tasks/t5/accept',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      // Verify the API was called with the tracked key
      const fetchCall = fetchMock.mock.calls.find(
        (call: any[]) => call[0].includes('/tasks/t5/accept'),
      );
      expect(fetchCall).toBeDefined();
      const body = JSON.parse(fetchCall![1].body);
      expect(body.executorSessionKey).toBe('agent:bot:sub:tracked');
    });
  });

  describe('POST /gateway/track-session', () => {
    it('tracks taskId to sessionKey', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/gateway/track-session',
        payload: { taskId: 't-track-1', sessionKey: 'agent:bot:sub:new-session' },
      });

      expect(response.statusCode).toBe(200);
      expect(sessionTracker.getSessionForTask('t-track-1')).toBe('agent:bot:sub:new-session');
    });
  });
});
