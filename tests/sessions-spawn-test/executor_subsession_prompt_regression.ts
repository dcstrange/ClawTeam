#!/usr/bin/env -S npx tsx

import assert from 'node:assert/strict';
import clawteamPlugin from '../../packages/openclaw-plugin/index.ts';

type HookHandler = (event: any, ctx: any) => Promise<any> | any;

function buildPluginHooks() {
  const hooks: Record<string, HookHandler> = {};
  clawteamPlugin.register({
    pluginConfig: { gatewayUrl: 'http://localhost:3100' },
    on(name: string, handler: HookHandler) {
      hooks[name] = handler;
    },
  });
  return hooks;
}

function countOccurrences(input: string, needle: string): number {
  const matched = input.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
  return matched ? matched.length : 0;
}

async function runPreRenderedIdempotenceCase(beforeToolCall: HookHandler) {
  const preRenderedTask = `[ClawTeam Sub-Session Context]\nYou are a ClawTeam executor sub-session.\n\nYOUR IDENTITY:\n  Bot ID: ba5d6c77-02b2-4dd8-bfbe-dcbbaea77af9\n  Bot Name: Bob-Code-Tester\n  Owner: bob@clawteam.dev\n\nDELEGATOR (who assigned this task to you):\n  Bot ID: abda8113-26cb-4210-8f31-96c6cd368a1f\n  Bot Name: fei\n  Owner: fei@clawteam.dev\n\nTask ID: ed9b7b94-8e9f-4f28-83c0-1ccaa52f3816\nRole: executor\nGateway: http://localhost:3100\n\n---\n\nYOUR PRIMARY JOB: Execute the task below and submit the result. Do the work yourself.\n\n---\n\nCOLLABORATION PRIMITIVES (use only when needed):\n\n=== TASK CONTENT BEGINS BELOW ===\nPrompt: 帮写一个代码，猜大小的游戏，100行以内。\nPriority: normal\nCapability: general\nParameters: {"delegateIntent":{"source":"dashboard_create_task_modal","toBotId":"ba5d6c77-02b2-4dd8-bfbe-dcbbaea77af9","toBotName":"Bob-Code-Tester","toBotOwner":"bob@clawteam.dev"}}`;

  const first = await beforeToolCall(
    {
      toolName: 'sessions_spawn',
      params: { task: preRenderedTask, label: 'regression-pre-rendered' },
    },
    { sessionKey: 'agent:main:subagent:test-1', role: 'executor' },
  );

  assert.ok(first?.params?.task, 'plugin should return transformed task params');
  const out = String(first.params.task);

  assert.equal(
    countOccurrences(out, '[ClawTeam Sub-Session Context]'),
    1,
    'pre-rendered prompt should not be duplicated',
  );
  assert.match(
    out,
    /DELEGATOR \(who assigned this task to you\):[\s\S]*?Bot ID:\s*abda8113-26cb-4210-8f31-96c6cd368a1f/,
    'delegator bot id should stay populated',
  );
}

async function runDoubleHookCase(beforeToolCall: HookHandler) {
  const taskId = 'ed9b7b94-8e9f-4f28-83c0-1ccaa52f3816';
  const fromBotId = 'abda8113-26cb-4210-8f31-96c6cd368a1f';
  const executorSeedTask = `<!--CLAWTEAM:{"role":"executor","taskId":"${taskId}","fromBotId":"${fromBotId}"}-->\nTask ID: ${taskId}\nPrompt: 帮写一个代码，猜大小的游戏，100行以内。\nPriority: normal\nCapability: general\nParameters: {"delegateIntent":{"source":"dashboard_create_task_modal","toBotId":"ba5d6c77-02b2-4dd8-bfbe-dcbbaea77af9","toBotName":"Bob-Code-Tester","toBotOwner":"bob@clawteam.dev"}}`;

  const first = await beforeToolCall(
    {
      toolName: 'sessions_spawn',
      params: { task: executorSeedTask, label: 'regression-double-hook' },
    },
    { sessionKey: 'agent:main:subagent:test-2', role: 'executor' },
  );

  assert.ok(first?.params?.task, 'first hook call should inject executor template');
  const firstTask = String(first.params.task);

  const second = await beforeToolCall(
    {
      toolName: 'sessions_spawn',
      params: { task: firstTask, label: 'regression-double-hook' },
    },
    { sessionKey: 'agent:main:subagent:test-2', role: 'executor' },
  );

  assert.ok(second?.params?.task, 'second hook call should still return task');
  const secondTask = String(second.params.task);

  assert.equal(
    countOccurrences(secondTask, '[ClawTeam Sub-Session Context]'),
    1,
    'second hook pass must remain idempotent (no duplicate context)',
  );
  assert.match(
    secondTask,
    /DELEGATOR \(who assigned this task to you\):[\s\S]*?Bot ID:\s*abda8113-26cb-4210-8f31-96c6cd368a1f/,
    'delegator info must remain populated after repeated hook invocation',
  );
}

async function main() {
  const hooks = buildPluginHooks();
  const beforeToolCall = hooks.before_tool_call;
  assert.equal(typeof beforeToolCall, 'function', 'before_tool_call hook must be registered');

  const originalFetch = globalThis.fetch;
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);

    if (url.endsWith('/gateway/me')) {
      return new Response(
        JSON.stringify({
          id: 'ba5d6c77-02b2-4dd8-bfbe-dcbbaea77af9',
          name: 'Bob-Code-Tester',
          ownerEmail: 'bob@clawteam.dev',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (url.includes('/gateway/bots/abda8113-26cb-4210-8f31-96c6cd368a1f')) {
      return new Response(
        'Bot: fei (abda8113-26cb-4210-8f31-96c6cd368a1f)\nOwner: fei@clawteam.dev\n',
        {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        },
      );
    }

    throw new Error(`Unexpected fetch in regression script: ${url}`);
  };

  try {
    globalThis.fetch = fakeFetch as typeof fetch;
    await runPreRenderedIdempotenceCase(beforeToolCall);
    await runDoubleHookCase(beforeToolCall);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('PASS executor_subsession_prompt_regression');
}

main().catch((error) => {
  console.error('FAIL executor_subsession_prompt_regression');
  console.error(error);
  process.exit(1);
});
