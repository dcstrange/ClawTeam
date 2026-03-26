#!/usr/bin/env -S npx tsx

import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerGatewayRoutes } from '../../packages/clawteam-gateway/src/gateway/gateway-proxy.js';

class MemoryTracker {
  private readonly map = new Map<string, string>();

  track(taskId: string, sessionKey: string): void {
    this.map.set(taskId, sessionKey);
  }

  untrack(taskId: string): void {
    this.map.delete(taskId);
  }

  getSessionForTask(taskId: string): string | undefined {
    return this.map.get(taskId);
  }

  getAllTracked(): Array<{ taskId: string; sessionKey: string }> {
    return Array.from(this.map.entries()).map(([taskId, sessionKey]) => ({ taskId, sessionKey }));
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function run(): Promise<void> {
  const originalFetch = global.fetch;
  const app = Fastify();
  try {
    const parentTaskId = 'parent-task-1';
    const childTaskId = 'child-task-1';
    const senderSessionKey = 'agent:main:subagent:sender-1';
    const tracker = new MemoryTracker();
    tracker.track(parentTaskId, senderSessionKey);

    const calls: Array<{ url: string; body?: any }> = [];
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      let parsedBody: any = undefined;
      if (init?.body && typeof init.body === 'string') {
        try { parsedBody = JSON.parse(init.body); } catch { parsedBody = init.body; }
      }
      calls.push({ url, body: parsedBody });

      if (url.endsWith(`/api/v1/tasks/${parentTaskId}/delegate`)) {
        return jsonResponse({
          success: true,
          data: {
            taskId: childTaskId,
            parentTaskId,
            toBotId: 'executor-bot',
            delegationMode: 'sub-task',
          },
        });
      }

      if (url.endsWith(`/api/v1/tasks/${childTaskId}/track-session`)) {
        return jsonResponse({
          success: true,
          data: {
            taskId: childTaskId,
            sessionKey: senderSessionKey,
            role: 'sender',
          },
        });
      }

      return jsonResponse({ success: true, data: {} });
    }) as typeof fetch;

    registerGatewayRoutes(app, {
      clawteamApiUrl: 'http://api.local',
      clawteamApiKey: 'test-key',
      clawteamBotId: 'sender-bot',
      sessionTracker: tracker,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/gateway/tasks/${parentTaskId}/delegate`,
      payload: {
        toBotId: 'executor-bot',
        subTaskPrompt: 'implement frontend slice',
      },
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.body, new RegExp(`Sub-task ${childTaskId} delegated to executor-bot`));
    assert.equal(tracker.getSessionForTask(childTaskId), senderSessionKey);

    // Wait one tick so fire-and-forget persistence call is captured.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const trackCall = calls.find((item) => item.url.endsWith(`/api/v1/tasks/${childTaskId}/track-session`));
    assert.ok(trackCall, 'expected child track-session API call');
    assert.deepEqual(trackCall?.body, {
      sessionKey: senderSessionKey,
      botId: 'sender-bot',
      role: 'sender',
    });

    console.log('PASS gateway_subdelegate_session_binding_regression');
  } finally {
    global.fetch = originalFetch;
    await app.close();
  }
}

run().catch((err) => {
  console.error('FAIL gateway_subdelegate_session_binding_regression');
  console.error(err);
  process.exit(1);
});
