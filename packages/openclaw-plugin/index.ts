/**
 * ClawTeam Auto Tracker Plugin
 *
 * Hooks into sessions_spawn and curl commands to automatically:
 * - Detect ClawTeam spawns via structured <!--CLAWTEAM:{...}--> token in task string
 *   (falls back to plain-text Role/Task ID/From Bot markers for legacy compat)
 * - Create tasks for sender role when no taskId is provided
 * - Inject role-specific system prompt into the task param
 * - Inject sessionKey into curl commands targeting gateway endpoints (auto-track)
 *
 * Session tracking is now handled by sessionKey injection into curl requests.
 * The gateway auto-tracks when it receives sessionKey + taskId in a request body.
 *
 * Placeholders in role-specific templates:
 *   {{TASK_ID}}        → real taskId
 *   {{ROLE}}           → executor | sender
 *   {{GATEWAY_URL}}    → gateway base URL (from pluginConfig.gatewayUrl)
 *   {{FROM_BOT_ID}}    → delegator bot ID
 *   {{FROM_BOT_NAME}}  → delegator bot name (fetched at spawn time)
 *   {{FROM_OWNER}}     → delegator bot owner (fetched at spawn time)
 *   {{MY_BOT_ID}}      → this bot's ID
 *   {{MY_BOT_NAME}}    → this bot's name
 *   {{MY_OWNER}}       → this bot's owner
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = '[clawteam-auto-tracker]';

/** Parsed task markers from the task string */
interface TaskMarkers {
  role?: string;       // 'executor' | 'sender'
  taskId?: string;
  fromBotId?: string;
}

/** Structured token format: <!--CLAWTEAM:{"role":"...","taskId":"...","fromBotId":"..."}--> */
const CLAWTEAM_TOKEN_RE = /<!--CLAWTEAM:(\{.*?\})-->/;

/** Parse ClawTeam markers from a task string.
 *  Primary: structured JSON token (immune to timestamp/indent/LLM rewrite).
 *  Fallback: plain-text Role:/Task ID:/From Bot: lines (legacy compat). */
function parseTaskMarkers(task: string): TaskMarkers | null {
  // Primary: structured token
  const tokenMatch = task.match(CLAWTEAM_TOKEN_RE);
  if (tokenMatch) {
    try {
      const parsed = JSON.parse(tokenMatch[1]);
      if (parsed.role) return parsed as TaskMarkers;
    } catch { /* fall through to legacy */ }
  }

  // Fallback: plain-text markers (tolerates leading whitespace and [timestamp] prefixes)
  const roleMatch = task.match(/^\s*(?:\[.*?\]\s*)?Role:\s*(\S+)/m);
  if (!roleMatch) return null;

  const taskIdMatch = task.match(/^\s*(?:\[.*?\]\s*)?Task ID:\s*(\S+)/m);
  const fromBotMatch = task.match(/^\s*(?:\[.*?\]\s*)?From Bot:\s*(\S+)/m);

  return {
    role: roleMatch[1],
    taskId: taskIdMatch?.[1] || undefined,
    fromBotId: fromBotMatch?.[1] || undefined,
  };
}

/** Strip ClawTeam markers from a task string so the sub-session doesn't see raw metadata */
function stripMarkerLines(task: string): string {
  return task
    // Remove structured token line
    .replace(/^.*<!--CLAWTEAM:\{.*?\}-->.*\n?/m, '')
    // Remove legacy plain-text markers
    .replace(/^\s*(?:\[.*?\]\s*)?Role:\s*\S+\n?/m, '')
    .replace(/^\s*(?:\[.*?\]\s*)?Task ID:\s*\S+\n?/m, '')
    .replace(/^\s*(?:\[.*?\]\s*)?From Bot:\s*\S+\n?/m, '')
    .replace(/^\n+/, ''); // trim leading blank lines left behind
}

/**
 * Inject sessionKey into a curl command targeting a gateway endpoint.
 * Returns the modified command, or null if no modification needed.
 */
function injectSessionKeyIntoCurl(
  command: string,
  sessionKey: string,
  gatewayUrl: string,
  role?: string,
): string | null {
  // Must contain curl and a gateway path
  if (!command.includes('curl') || !command.includes(gatewayUrl + '/gateway/')) return null;

  try {
    // Handle pipe chains: only modify the curl part (before first |)
    const pipeIdx = command.indexOf('|');
    const curlPart = pipeIdx >= 0 ? command.slice(0, pipeIdx) : command;
    const pipeSuffix = pipeIdx >= 0 ? command.slice(pipeIdx) : '';

    // Merge continuation lines for easier parsing
    const merged = curlPart.replace(/\\\n\s*/g, ' ');

    // Match -d / --data / --data-raw argument (single or double quoted)
    const dataMatch = merged.match(/(?:-d|--data|--data-raw)\s+(['"])([\s\S]*?)\1/);
    if (!dataMatch) return null; // No -d body (GET request or non-JSON)

    const quote = dataMatch[1];
    const bodyStr = dataMatch[2];

    // Try to parse as JSON
    let body: Record<string, any>;
    try {
      body = JSON.parse(bodyStr);
    } catch {
      return null; // Non-JSON body, skip
    }

    // Idempotent: already has sessionKey
    if (body.sessionKey) return null;

    // Inject sessionKey
    body.sessionKey = sessionKey;
    if (role) body.sessionKeyRole = role;
    const newBodyStr = JSON.stringify(body);

    // Rebuild the curl command with the new body
    const originalDataArg = dataMatch[0];
    const newDataArg = originalDataArg.replace(
      `${quote}${bodyStr}${quote}`,
      `${quote}${newBodyStr}${quote}`,
    );
    const newMerged = merged.replace(originalDataArg, newDataArg);

    return newMerged + pipeSuffix;
  } catch (err) {
    console.warn(`${TAG} injectSessionKeyIntoCurl parse error:`, (err as Error).message);
    return null;
  }
}

/** Shared headers for gateway JSON API calls */
const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
};

/** Fetch bot info from gateway. Returns { id, name, ownerEmail } or null. */
async function fetchBotInfo(gatewayUrl: string, botId: string): Promise<{ id: string; name: string; ownerEmail?: string } | null> {
  try {
    const res = await fetch(`${gatewayUrl}/gateway/bots/${botId}`, {
      headers: { 'Accept': 'text/plain' },
    });
    if (!res.ok) return null;
    const text = await res.text();
    // Response is formatted text: "Bot: <name> (<id>)\nOwner: <email>\n..."
    const nameMatch = text.match(/^Bot:\s*(.+?)\s*\([\w-]+\)/m);
    const ownerMatch = text.match(/^Owner:\s*(.+)/m);
    return {
      id: botId,
      name: nameMatch?.[1]?.trim() || botId,
      ownerEmail: ownerMatch?.[1]?.trim(),
    };
  } catch {
    return null;
  }
}

/** Fetch self bot info from /gateway/me (returns JSON). */
async function fetchSelfBotInfo(gatewayUrl: string): Promise<{ id: string; name: string; ownerEmail?: string } | null> {
  try {
    const res = await fetch(`${gatewayUrl}/gateway/me`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    return { id: data.id, name: data.name, ownerEmail: data.ownerEmail };
  } catch {
    return null;
  }
}

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
    .replaceAll('{{FROM_BOT_ID}}', vars.fromBotId ?? '')
    .replaceAll('{{FROM_BOT_NAME}}', vars.fromBotName ?? 'unknown')
    .replaceAll('{{FROM_OWNER}}', vars.fromOwner ?? 'unknown')
    .replaceAll('{{MY_BOT_ID}}', vars.myBotId ?? '')
    .replaceAll('{{MY_BOT_NAME}}', vars.myBotName ?? 'unknown')
    .replaceAll('{{MY_OWNER}}', vars.myOwner ?? 'unknown');
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

    // Cached self bot info (fetched lazily on first spawn)
    let selfBot: { id: string; name: string; ownerEmail?: string } | null = null;
    let selfBotFetched = false;

    async function ensureSelfBot(): Promise<void> {
      if (selfBotFetched) return;
      selfBotFetched = true;
      selfBot = await fetchSelfBotInfo(gw);
      if (selfBot) {
        console.log(`${TAG} self bot: ${selfBot.name} (${selfBot.id}), owner: ${selfBot.ownerEmail || 'unknown'}`);
      } else {
        console.warn(`${TAG} failed to fetch self bot info from ${gw}/gateway/me`);
      }
    }

    // Cross-hook state: last taskId set by before_tool_call, consumed by tool_result_persist
    let pendingTaskId: string | null = null;

    // =========================================================================
    // before_tool_call: spawn detection + curl sessionKey injection
    // =========================================================================
    api.on('before_tool_call', async (event: any, ctx: any) => {
      // --- Path 1: sessions_spawn (template injection + sender task creation) ---
      if (event.toolName === 'sessions_spawn') {
        const rawTask = String(event.params?.task ?? '');
        console.log(`${TAG} sessions_spawn detected, task length=${rawTask.length}, first 200 chars: ${rawTask.slice(0, 200)}`);
        const markers = parseTaskMarkers(rawTask);
        console.log(`${TAG} parseTaskMarkers result:`, JSON.stringify(markers));

        if (!markers?.role) return; // Not a ClawTeam spawn, skip

        let { role, taskId, fromBotId } = markers;
        fromBotId = fromBotId || '';

        console.log(`${TAG} before_tool_call: role=${role}, taskId=${taskId || '(none)'}, fromBotId=${fromBotId || '(none)'}`);

        // Sender without taskId: auto-create task via gateway (block spawn on failure)
        if (!taskId && role === 'sender') {
          const task = stripMarkerLines(rawTask);
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
            const data = await res.json() as Record<string, any>;
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
          console.error(`${TAG} executor role requires taskId`);
          return { block: true, blockReason: 'Executor spawn requires Task ID in the task markers.' };
        }

        // Non-sender roles require fromBotId
        if (role !== 'sender' && !fromBotId) {
          console.error(`${TAG} role="${role}" requires fromBotId`);
          return { block: true, blockReason: `Role "${role}" requires From Bot in the task markers.` };
        }

        // Strip marker lines from task content so sub-session doesn't see raw markers
        const cleanTask = stripMarkerLines(rawTask);
        const injectedParams: Record<string, any> = {};

        const template = templates[role!] || '';
        if (template) {
          // Fetch self bot info (lazy, cached)
          await ensureSelfBot();

          // Fetch from-bot info for executor role
          let fromBotName = '';
          let fromOwner = '';
          if (fromBotId) {
            const fromBot = await fetchBotInfo(gw, fromBotId);
            if (fromBot) {
              fromBotName = fromBot.name;
              fromOwner = fromBot.ownerEmail || '';
            }
          }

          const rendered = renderTemplate(template, {
            taskId: taskId!,
            role: role!,
            gatewayUrl: gw,
            fromBotId,
            fromBotName,
            fromOwner,
            myBotId: selfBot?.id || '',
            myBotName: selfBot?.name || '',
            myOwner: selfBot?.ownerEmail || '',
          });
          injectedParams.task = rendered + cleanTask;
          console.log(`${TAG} injected ${role} system prompt into task (taskId=${taskId})`);
        } else {
          injectedParams.task = cleanTask;
        }

        pendingTaskId = taskId!;
        console.log(`${TAG} returning injected params, task length=${injectedParams.task?.length}, first 200 chars: ${String(injectedParams.task).slice(0, 200)}`);
        return { params: injectedParams };
      }

      // --- Path 2: curl sessionKey injection ---
      const command = event.params?.command;
      if (typeof command === 'string' && command.includes('curl') && command.includes(gw)) {
        const sessionKey = ctx?.sessionKey;
        if (!sessionKey) return;

        const modified = injectSessionKeyIntoCurl(command, sessionKey, gw, ctx?.role);
        if (modified) {
          console.log(`${TAG} injected sessionKey into curl command`);
          return { params: { ...event.params, command: modified } };
        }
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
