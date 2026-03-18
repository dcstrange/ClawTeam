/**
 * ClawTeam Auto Tracker Plugin
 *
 * Hooks into sessions_spawn to automatically:
 * - Detect ClawTeam spawns via [CLAWTEAM_META] block in task string (or _clawteam_role param for backward compat)
 * - Create tasks for sender role when no taskId is provided
 * - Inject role-specific system prompt (task_system_prompt_executor.md or task_system_prompt_sender.md) into the task param (prepended), replacing placeholders
 * - Track sessions via /gateway/track-session after spawn completes
 *
 * Detection sources (checked in order):
 *   1. _clawteam_role / _clawteam_taskId / _clawteam_from_bot_id params (backward compat)
 *   2. [CLAWTEAM_META] block parsed from task string (primary)
 *
 * Placeholders in role-specific templates:
 *   {{TASK_ID}}      → real taskId
 *   {{ROLE}}         → executor | sender
 *   {{GATEWAY_URL}}  → gateway base URL (from pluginConfig.gatewayUrl)
 *   {{FROM_BOT_ID}}  → delegator bot ID
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TASK_ID_KEY = '_clawteam_taskId';
const ROLE_KEY = '_clawteam_role';
const FROM_BOT_ID_KEY = '_clawteam_from_bot_id';
const TAG = '[clawteam-auto-tracker]';

/** Parsed ClawTeam metadata from a task string's [CLAWTEAM_META] block */
interface ClawTeamMeta {
  role: string;
  taskId?: string;
  fromBotId?: string;
  cleanTask: string;
}

const META_RE = /\[CLAWTEAM_META\]\n([\s\S]*?)\n\[\/CLAWTEAM_META\]\n?/;

/** Parse [CLAWTEAM_META]...[/CLAWTEAM_META] from a task string */
function parseClawTeamMeta(task: string): ClawTeamMeta | null {
  const m = META_RE.exec(task);
  if (!m) return null;
  const kvs: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) kvs[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  if (!kvs.role) return null;
  return {
    role: kvs.role,
    taskId: kvs.taskId || undefined,
    fromBotId: kvs.fromBotId || undefined,
    cleanTask: task.replace(META_RE, ''),
  };
}

/** Strip [CLAWTEAM_META] block from a task string (idempotent) */
function stripMetaBlock(task: string): string {
  return task.replace(META_RE, '');
}

/** Shared headers for gateway JSON API calls */
const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
};

/** Load a template file from the plugin directory */
function loadTemplate(filename: string): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const templatePath = path.join(dir, filename);
    return fs.readFileSync(templatePath, 'utf-8');
  } catch (err) {
    console.warn(`${TAG} failed to load ${filename}:`, (err as Error).message);
    return '';
  }
}

/** Replace all known placeholders in the template */
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template
    .replaceAll('{{TASK_ID}}', vars.taskId ?? '')
    .replaceAll('{{ROLE}}', vars.role ?? '')
    .replaceAll('{{GATEWAY_URL}}', vars.gatewayUrl ?? '')
    .replaceAll('{{FROM_BOT_ID}}', vars.fromBotId ?? '');
}

export default {
  id: 'clawteam-auto-tracker',
  name: 'ClawTeam Auto Tracker',

  register(api: any) {
    const config = api.pluginConfig ?? {};
    if (config.enabled === false) return;
    const gw = config.gatewayUrl || 'http://localhost:3100';

    const templates: Record<string, string> = {
      executor: loadTemplate('task_system_prompt_executor.md'),
      sender: loadTemplate('task_system_prompt_sender.md'),
    };
    const hasTemplates = Object.values(templates).some(Boolean);
    console.log(`${TAG} registered (gateway: ${gw}, templates: ${hasTemplates ? 'loaded' : 'missing'})`);

    // Cross-hook state: last taskId set by before_tool_call, consumed by tool_result_persist
    let pendingTaskId: string | null = null;
    // =========================================================================
    // before_tool_call: create task if needed, inject system prompt into task
    // =========================================================================
    api.on('before_tool_call', async (event: any, _ctx: any) => {
      if (event.toolName !== 'sessions_spawn') return;

      // --- Source 1: explicit params (backward compat with old sessions) ---
      let role = event.params?.[ROLE_KEY];
      let taskId = event.params?.[TASK_ID_KEY];
      let fromBotId = String(event.params?.[FROM_BOT_ID_KEY] ?? '');

      // --- Source 2: parse [CLAWTEAM_META] from task string ---
      const rawTask = String(event.params?.task ?? '');
      const meta = parseClawTeamMeta(rawTask);

      if (!role && meta) {
        role = meta.role;
        if (!taskId && meta.taskId) taskId = meta.taskId;
        if (!fromBotId && meta.fromBotId) fromBotId = meta.fromBotId;
        console.log(`${TAG} before_tool_call: resolved from task meta block: role=${role}, taskId=${taskId || '(none)'}, fromBotId=${fromBotId || '(none)'}`);
      }

      if (!role) return; // Not a ClawTeam spawn, skip

      console.log(`${TAG} before_tool_call: role=${role}, taskId=${taskId || '(none)'}, fromBotId=${fromBotId || '(none)'}`);

      // Sender without taskId: auto-create task via gateway (block spawn on failure)
      if (!taskId && role === 'sender') {
        const task = stripMetaBlock(rawTask);
        const label = String(event.params?.label ?? '');
        console.log(`${TAG} creating task via ${gw}/gateway/tasks/create`);
        try {
          const res = await fetch(`${gw}/gateway/tasks/create`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ prompt: task, title: label || task.slice(0, 100) }),
          });
          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            console.error(`${TAG} create task failed, HTTP ${res.status}: ${errText}`);
            return { block: true, blockReason: `Failed to create task (HTTP ${res.status}). Fix the issue before spawning.` };
          }
          const data = await res.json();
          taskId = data.taskId || data.data?.taskId;
          if (!taskId) {
            console.error(`${TAG} create task response missing taskId:`, JSON.stringify(data));
            return { block: true, blockReason: 'Failed to create task: response missing taskId.' };
          }
          console.log(`${TAG} task created, taskId=${taskId}`);
        } catch (err) {
          console.error(`${TAG} create task error:`, (err as Error).message);
          return { block: true, blockReason: `Failed to create task: ${(err as Error).message}` };
        }
      }

      // Executor without taskId: block spawn
      if (!taskId && role === 'executor') {
        console.error(`${TAG} executor role requires taskId (via param or meta block)`);
        return { block: true, blockReason: 'Executor spawn requires _clawteam_taskId param or taskId in [CLAWTEAM_META] block.' };
      }

      // Non-sender roles require fromBotId
      if (role !== 'sender' && !fromBotId) {
        console.error(`${TAG} role="${role}" requires fromBotId (via param or meta block)`);
        return { block: true, blockReason: `Role "${role}" requires _clawteam_from_bot_id param or fromBotId in [CLAWTEAM_META] block.` };
      }

      // Strip meta block from task content so sub-session doesn't see raw markers
      const cleanTask = stripMetaBlock(rawTask);
      const injectedParams: Record<string, any> = {
        [TASK_ID_KEY]: taskId,
        [ROLE_KEY]: role,
      };

      const template = templates[role] || '';
      if (template) {
        const rendered = renderTemplate(template, {
          taskId: taskId!,
          role,
          gatewayUrl: gw,
          fromBotId,
        });
        injectedParams.task = rendered + cleanTask;
        console.log(`${TAG} injected ${role} system prompt into task (taskId=${taskId})`);
      } else {
        injectedParams.task = cleanTask;
      }

      pendingTaskId = taskId!;
      return { params: injectedParams };
    });

    // =========================================================================
    // after_tool_call: track session after spawn completes
    // =========================================================================
    api.on('after_tool_call', async (event: any, _ctx: any) => {
      if (event.toolName !== 'sessions_spawn') return;

      const taskId = event.params?.[TASK_ID_KEY];
      const role = event.params?.[ROLE_KEY];
      if (!taskId || !role) return;

      console.log(`${TAG} after_tool_call: taskId=${taskId}, role=${role}`);

      if (event.error) {
        console.warn(`${TAG} spawn error, skipping track-session:`, event.error);
        return;
      }

      const details = (event.result as any)?.details;
      console.log(`${TAG} after_tool_call: result.details=`, JSON.stringify(details));

      if (details?.status !== 'accepted') {
        console.warn(`${TAG} spawn status="${details?.status}", skipping track-session`);
        return;
      }

      const childSessionKey = details?.childSessionKey;
      if (!childSessionKey) {
        console.warn(`${TAG} no childSessionKey in spawn result, skipping track-session`);
        return;
      }

      console.log(`${TAG} calling ${gw}/gateway/track-session`);
      try {
        const res = await fetch(`${gw}/gateway/track-session`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ taskId, sessionKey: childSessionKey, role }),
        });
        console.log(`${TAG} track-session response: HTTP ${res.status}`);
      } catch (err) {
        console.warn(`${TAG} track-session error:`, (err as Error).message);
      }
    });

    // =========================================================================
    // tool_result_persist: append taskId to the sessions_spawn result shown to main session
    // =========================================================================
    api.on('tool_result_persist', (event: any, _ctx: any) => {
      if (event.toolName !== 'sessions_spawn') return;
      const taskId = pendingTaskId;
      pendingTaskId = null; // consume
      if (!taskId) return;

      const msg = event.message;
      if (!msg) return;

      // Append taskId to the text content of the tool result message
      const appendText = `\n[ClawTeam] taskId: ${taskId}`;
      if (Array.isArray(msg.content)) {
        const textBlock = msg.content.find((b: any) => b.type === 'tool_result' || b.type === 'text');
        if (textBlock) {
          if (typeof textBlock.content === 'string') {
            textBlock.content += appendText;
          } else if (Array.isArray(textBlock.content)) {
            const inner = textBlock.content.find((b: any) => b.type === 'text');
            if (inner) inner.text = (inner.text ?? '') + appendText;
          }
        }
      } else if (typeof msg.content === 'string') {
        msg.content += appendText;
      }

      console.log(`${TAG} appended taskId=${taskId} to sessions_spawn result`);
      return { message: msg };
    });
  },
};
