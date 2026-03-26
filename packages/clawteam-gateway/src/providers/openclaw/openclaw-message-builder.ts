/**
 * OpenClaw Message Builder
 *
 * 实现 IMessageBuilder 接口，生成 OpenClaw 专属的 LLM 指令消息。
 * 消息包含 <!--CLAWTEAM:...--> 元数据 token、sessions_spawn 指令、
 * 以及 gateway curl 命令。
 *
 * 从 router.ts 提取 4 个方法:
 *   - buildNewTaskMessage (L748)
 *   - buildSubTaskMessage (L791)
 *   - buildDelegateIntentMessage (L479)
 *   - buildFallbackMessage (L812, async→sync: getTask 调用移到调用方)
 *
 * 从 stale-task-recovery-loop.ts 提取 2 个方法:
 *   - buildNudgeMessage (L780)
 *   - buildRecoveryFallbackMessage (L817, 原名 buildFallbackMessage)
 *
 * cleanPromptForExecutor() 辅助方法一并迁入。
 */

import type { Task } from '@clawteam/shared/types';
import type { IMessageBuilder, DelegateTarget } from '../types.js';

export class OpenClawMessageBuilder implements IMessageBuilder {
  /**
   * @param gatewayUrl - Gateway 基础 URL，用于生成 curl 命令。
   *   共 7 处引用：nudge 2 处 + recoveryFallback 5 处。
   */
  constructor(private readonly gatewayUrl: string) {}

  // ── Router 消息构建方法 ──────────────────────────────────────

  /**
   * 新任务 → 主 session：包含 CLAWTEAM 元数据 token 和 spawn 指令。
   * 所有任务详情嵌入 task value 中，单次 spawn 即可，无需后续 sessions_send。
   */
  buildNewTaskMessage(task: Task, fromBotName?: string): string {
    const cleanPrompt = this.cleanPromptForExecutor(task.prompt);
    const paramsLine = task.parameters && Object.keys(task.parameters).length > 0
      ? `\nParameters: ${JSON.stringify(task.parameters)}`
      : '';

    const taskContent = [
      `Task ID: ${task.id}`,
      ...(cleanPrompt ? [`Prompt: ${cleanPrompt}`] : []),
      `Capability: ${task.capability}`,
      ...(paramsLine ? [paramsLine.trim()] : []),
    ].join('\n');

    const token = `<!--CLAWTEAM:${JSON.stringify({ role: 'executor', taskId: task.id, fromBotId: task.fromBotId })}-->`;
    const executorTaskValue = `${token}\n${taskContent}`;
    const fromBotLabel = fromBotName ? `${fromBotName} (${task.fromBotId})` : task.fromBotId;

    return [
      '[ClawTeam Task Received]',
      `Task ID: ${task.id}`,
      `Capability: ${task.capability}`,
      `Type: ${task.type || 'new'}`,
      `From Bot: ${fromBotLabel}`,
      `Priority: ${task.priority}`,
      ...(cleanPrompt ? [`Prompt: ${cleanPrompt}`, ''] : ['']),
      '',
      'ACTION REQUIRED: Spawn a sub-session now.',
      'DO NOT call any /tasks/ API endpoints yourself. The plugin handles tracking automatically.',
      '',
      'IMPORTANT: The task value MUST include the <!--CLAWTEAM:...--> line exactly as shown.',
      'This token is required for the plugin to inject execution rules. Copy it verbatim.',
      '',
      '---TASK VALUE START---',
      executorTaskValue,
      '---TASK VALUE END---',
      '',
      `label: "${(cleanPrompt || task.capability || '').slice(0, 60)}"`,
      '',
      'Pass everything between the START/END markers as the task value.',
      'No follow-up sessions_send is needed — all task details are included in the task value.',
    ].join('\n');
  }

  /** 子任务 → 目标 session：直接在已有 session 中执行。 */
  buildSubTaskMessage(task: Task): string {
    const taskType = task.type || 'sub-task';
    return [
      `[ClawTeam ${taskType} Task]`,
      `Task ID: ${task.id}`,
      ...(task.prompt ? [`Prompt: ${task.prompt}`] : []),
      `Capability: ${task.capability}`,
      ...(task.parameters && Object.keys(task.parameters).length > 0
        ? [`Parameters: ${JSON.stringify(task.parameters)}`]
        : []),
      `Parent Task: ${task.parentTaskId}`,
      '',
      `Process this ${taskType} in the context of your previous work on task ${task.parentTaskId}.`,
      `The task has been auto-accepted by the gateway. Start working immediately.`,
    ].join('\n');
  }

  /**
   * delegate intent → 主 session：包含 CLAWTEAM 元数据 token（sender 角色）和 spawn 指令。
   * Task value 仅包含 meta block + 任务事实，plugin 注入 sender 专属规则。
   */
  buildDelegateIntentMessage(
    taskId: string,
    prompt: string,
    fromBotId: string,
    target: DelegateTarget,
  ): string {
    const intentText = prompt || '';
    const cleanPrompt = intentText.trim();
    const taskIdRef = taskId || 'TASK_ID';
    const toBotId = target.toBotId?.trim() || '';
    const toBotName = target.toBotName?.trim() || '';
    const toBotOwner = target.toBotOwner?.trim() || '';
    const intentLabel = (toBotId
      ? `Delegate a task to bot ${toBotId}:`
      : cleanPrompt) || 'Delegate a task';

    // Task content 仅为 intent 信息 — 委派规则由 sender template 注入
    const taskContentLines = [
      `From Bot: ${fromBotId}`,
      `Intent: ${intentLabel}`,
      `Task ID: ${taskIdRef}`,
    ];
    if (cleanPrompt && cleanPrompt !== intentLabel) taskContentLines.push(`Prompt: ${cleanPrompt}`);
    if (toBotId) taskContentLines.push(`To Bot: ${toBotId}`);
    if (toBotName) taskContentLines.push(`To Bot Name: ${toBotName}`);
    if (toBotOwner) taskContentLines.push(`To Bot Owner: ${toBotOwner}`);
    const taskContent = taskContentLines.join('\n');

    const tokenData: Record<string, string> = {
      role: 'sender',
      fromBotId: fromBotId || '',
    };
    if (taskId) tokenData.taskId = taskId;
    if (toBotId) tokenData.toBotId = toBotId;
    if (toBotName) tokenData.toBotName = toBotName;
    if (toBotOwner) tokenData.toBotOwner = toBotOwner;
    const token = `<!--CLAWTEAM:${JSON.stringify(tokenData)}-->`;
    const taskValue = `${token}\n${taskContent}`;

    const taskIdLine = taskId
      ? `Task ID: ${taskId} (pre-created by dashboard)`
      : 'No taskId yet. The plugin will auto-create it when spawning.';

    return [
      '[ClawTeam Delegate Intent]',
      `From Bot: ${fromBotId}`,
      `Intent: ${intentLabel}`,
      taskIdLine,
      '',
      'ACTION REQUIRED: Spawn a sub-session now.',
      '',
      'IMPORTANT: The task value MUST include the <!--CLAWTEAM:...--> line exactly as shown.',
      'This token is required for the plugin to inject delegation rules. Copy it verbatim.',
      '',
      '---TASK VALUE START---',
      taskValue,
      '---TASK VALUE END---',
      '',
      `label: "${intentLabel.substring(0, 60)}"`,
      '',
      'Pass everything between the START/END markers as the task value.',
      'No follow-up sessions_send is needed — all task details are included in the task value.',
    ].join('\n');
  }

  /**
   * Session 过期 fallback → 主 session：重新派发到新 sub-session。
   *
   * 注意：原 router.ts 的 buildFallbackMessage 是 async（内部调用 getTask）。
   * 现在改为 sync：调用方负责预取 parentContext 作为参数传入。
   */
  buildFallbackMessage(task: Task, parentContext?: string): string {
    const taskType = task.type || 'sub-task';

    const taskContent = [
      `Task ID: ${task.id}`,
      ...(task.prompt ? [`Prompt: ${task.prompt}`] : []),
      `Capability: ${task.capability}`,
      `Type: ${taskType}`,
      `Parent Task: ${task.parentTaskId}`,
      ...(task.parameters && Object.keys(task.parameters).length > 0
        ? [`Parameters: ${JSON.stringify(task.parameters)}`]
        : []),
      parentContext || '',
    ].join('\n');

    const roleHeader = `Role: executor\nTask ID: ${task.id}\nFrom Bot: ${task.fromBotId}`;
    const executorTaskValue = `${roleHeader}\n${taskContent}`;

    const taskLines = executorTaskValue.split('\n').map(line => `     ${line}`).join('\n');

    return [
      `[ClawTeam Task Received]`,
      `Task ID: ${task.id}`,
      ...(task.prompt ? [`Prompt: ${task.prompt}`] : []),
      `Capability: ${task.capability}`,
      `Type: ${task.type || 'sub-task'}`,
      `Parent Task: ${task.parentTaskId}`,
      `From Bot: ${task.fromBotId}`,
      `Priority: ${task.priority}`,
      '',
      'ACTION REQUIRED: Spawn a sub-session with this task value:',
      'DO NOT call any /tasks/ API endpoints yourself. The plugin handles tracking automatically.',
      '',
      taskLines,
      '',
      `   label: "${(task.prompt || task.capability || '').slice(0, 60)}"`,
      '',
      'The task value above is a multi-line string. Pass it exactly as shown (without the leading spaces).',
      'No follow-up sessions_send is needed — all task details are included in the task value.',
    ].join('\n');
  }

  // ── Recovery Loop 消息构建方法 ───────────────────────────────

  /**
   * 恢复循环 fallback → 主 session：完整的三步流程（spawn → track → send details）。
   * 映射自 stale-task-recovery-loop.ts buildFallbackMessage()
   */
  buildRecoveryFallbackMessage(task: Task): string {
    const taskId = task.id;
    const instructions = task.prompt || `Execute the "${task.capability || 'general'}" capability`;
    const hasParams = task.parameters && Object.keys(task.parameters).length > 0;

    return [
      '[ClawTeam Task Received]',
      `Task ID: ${taskId}`,
      `Instructions: ${instructions}`,
      task.capability && task.capability !== 'general' ? `Capability: ${task.capability}` : null,
      `Type: ${task.type || 'new'}`,
      `From Bot: ${task.fromBotId}`,
      `Priority: ${task.priority}`,
      '',
      'ACTION REQUIRED: Unified task flow:',
      'DO NOT call any /tasks/ API endpoints yourself. The sub-session handles the full lifecycle.',
      '',
      '1. Spawn an EMPTY sub-session (no task details in the spawn prompt).',
      '   Just tell it: "You are a ClawTeam task executor. Wait for instructions."',
      '',
      `2. After spawning, call track-session to link the task to the sub-session:`,
      `   curl -s -X POST ${this.gatewayUrl}/gateway/track-session -H 'Content-Type: application/json' -d '{"taskId":"${taskId}","sessionKey":"THE_CHILD_SESSION_KEY"}'`,
      '',
      '3. Then send the full task details to the sub-session (below).',
      '',
      '=== SUB-SESSION TASK DETAILS (send via sessions_send after track-session) ===',
      '',
      `You are a ClawTeam sub-session. Execute the task below step by step.`,
      `The task has been auto-accepted by the gateway. Start working immediately.`,
      '',
      `Task ID: ${taskId}`,
      `Instructions: ${instructions}`,
      hasParams ? `Additional Context: ${JSON.stringify(task.parameters)}` : null,
      '',
      `Step 1: Execute the instructions above.`,
      '',
      `CRITICAL RULE: NEVER call /complete unless you have actually produced the requested deliverable.`,
      `If you cannot fulfill the request for ANY reason (missing APIs, insufficient permissions, missing info):`,
      `  - Do NOT call /complete. No exceptions. A "cannot do" summary is NOT a valid completion.`,
      `  - Instead, follow the information-gathering steps below.`,
      '',
      `INFORMATION GATHERING -- follow this order:`,
      `  1. Task-related info (personal details, preferences, travel dates, names, budgets, etc.)`,
      `     These belong to the DELEGATOR's human user. Ask the delegator bot via DM:`,
      `     curl -s -X POST ${this.gatewayUrl}/gateway/messages/send -H 'Content-Type: application/json' -d '{"toBotId":"${task.fromBotId}","taskId":"${taskId}","content":"YOUR_QUESTION"}'`,
      `     The delegator bot will answer from context or escalate to its own human.`,
      `  2. Executor-specific info (your API keys, system config, tool access, credentials)`,
      `     Only YOUR human user can provide these. Call /need-human-input:`,
      `     curl -s -X POST ${this.gatewayUrl}/gateway/tasks/${taskId}/need-human-input -H 'Content-Type: application/json' -d '{"reason":"DESCRIBE_WHAT_YOU_NEED","targetBotId":"${task.toBotId}"}'`,
      `     This asks YOUR human user only. Then STOP and wait.`,
      `  3. If you are completely blocked and neither approach applies, call /need-human-input as a last resort.`,
      '',
      `Step 2: Complete the task:`,
      `  curl -s -X POST ${this.gatewayUrl}/gateway/tasks/${taskId}/complete -H 'Content-Type: application/json' -d '{"status":"completed","result":{"summary":"YOUR_OUTPUT"}}'`,
      '',
      '=== END SUB-SESSION TASK DETAILS ===',
    ].filter(Boolean).join('\n');
  }

  /**
   * 恢复循环 nudge → stale session：提醒继续工作。
   * 映射自 stale-task-recovery-loop.ts buildNudgeMessage()
   *
   * 参数重排序说明：
   *   原: (taskId, sessionKey, sessionState, task, attemptNum)
   *   新: (taskId, task, sessionState, attemptNum, maxAttempts)
   *   - sessionKey 在消息文本中未使用，故删除
   *   - maxAttempts 从 this.attemptTracker 内部访问改为显式参数
   */
  buildNudgeMessage(
    taskId: string,
    task: Task,
    sessionState: string,
    attemptNum: number,
    maxAttempts: number,
  ): string {
    const instructions = task.prompt || `Execute the "${task.capability || 'general'}" capability`;

    return [
      '[ClawTeam Task Recovery — Nudge]',
      `Task ID: ${taskId}`,
      `Instructions: ${instructions}`,
      task.capability && task.capability !== 'general' ? `Capability: ${task.capability}` : null,
      `Status: ${task.status}`,
      `Session State Detected: ${sessionState}`,
      `Recovery Attempt: ${attemptNum}/${maxAttempts}`,
      '',
      'Your session appears to have gone idle while this task is still in-progress.',
      'Please continue working on the task and complete it when done.',
      '',
      `If you need task-related info (personal details, preferences, etc.), ask the delegator bot via DM first.`,
      `If you need executor-specific info (API keys, credentials), call /need-human-input:`,
      `  curl -s -X POST ${this.gatewayUrl}/gateway/tasks/${taskId}/need-human-input -H 'Content-Type: application/json' -d '{"reason":"DESCRIBE_WHAT_YOU_NEED","targetBotId":"${task.toBotId}"}'`,
      '',
      `Complete using:`,
      `  curl -s -X POST ${this.gatewayUrl}/gateway/tasks/${taskId}/complete -H 'Content-Type: application/json' \\`,
      `    -d '{"status":"completed","result":{"summary":"<your output>"}}'`,
    ].filter(Boolean).join('\n');
  }

  // ── 辅助方法 ─────────────────────────────────────────────────

  /**
   * 清除委派前缀，使 executor 只看到实际任务内容。
   * 例: "Delegate a task to bot abc123: \nPrompt: 写一个消息队列" → "写一个消息队列"
   */
  private cleanPromptForExecutor(prompt: string | undefined): string | undefined {
    if (!prompt) return prompt;
    let cleaned = prompt.replace(/^Delegate\s+a\s+task\s+to\s+bot\s+[\w-]+:\s*/i, '');
    cleaned = cleaned.replace(/^Prompt:\s*/i, '');
    return cleaned.trim() || prompt;
  }
}
