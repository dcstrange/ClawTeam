/**
 * Core Task Router
 *
 * Two-phase design:
 * 1. decide(task) -- Pure function, no I/O. Maps task.type to routing action.
 * 2. execute(decision) -- Performs I/O: sends messages to OpenClaw sessions.
 *
 * Routing rules:
 * - type=new (or undefined): send to main session (main session spawns sub-session)
 * - type=sub-task with targetSessionKey: send to that session
 * - type=sub-task without targetSessionKey: fallback to main session
 * - If target session is expired: fallback to main session with parent context
 */

import { EventEmitter } from 'node:events';
import type { Task } from '@clawteam/shared/types';
import type { InboxMessage, RoutingDecision, RoutingResult } from '../types.js';
import type { IClawTeamApiClient } from '../clients/clawteam-api.js';
import type { IOpenClawSessionClient } from '../clients/openclaw-session.js';
import type { SessionTracker } from './session-tracker.js';
import type { Logger } from 'pino';
import { printRouteBlock } from '../utils/visual-log.js';

export interface TaskRouterDeps {
  clawteamApi: IClawTeamApiClient;
  openclawSession: IOpenClawSessionClient;
  sessionTracker: SessionTracker;
  logger: Logger;
  gatewayUrl: string;
  botId?: string;
}

export class TaskRouter extends EventEmitter {
  private readonly clawteamApi: IClawTeamApiClient;
  private readonly openclawSession: IOpenClawSessionClient;
  private readonly sessionTracker: SessionTracker;
  private readonly logger: Logger;
  private readonly gatewayUrl: string;
  private readonly botId?: string;

  constructor(deps: TaskRouterDeps) {
    super();
    this.clawteamApi = deps.clawteamApi;
    this.openclawSession = deps.openclawSession;
    this.sessionTracker = deps.sessionTracker;
    this.logger = deps.logger.child({ component: 'router' });
    this.gatewayUrl = deps.gatewayUrl;
    this.botId = deps.botId;
  }

  /**
   * Phase 1: Decide where to route a task (pure logic, no I/O).
   */
  decide(task: Task): RoutingDecision {
    const taskType = task.type || 'new';

    if (taskType === 'new') {
      return {
        taskId: task.id,
        action: 'send_to_main',
        task,
        reason: 'New task -- main session will spawn sub-session to handle it',
      };
    }

    // sub-task
    const targetSessionKey = task.parameters?.targetSessionKey as string | undefined;

    if (targetSessionKey) {
      return {
        taskId: task.id,
        action: 'send_to_session',
        targetSessionKey,
        task,
        reason: `${taskType} task -- routing to target session ${targetSessionKey}`,
      };
    }

    // No targetSessionKey -- try resolving via parentTaskId from sessionTracker
    if (task.parentTaskId) {
      const resolvedSessionKey = this.sessionTracker.getSessionForTask(task.parentTaskId);
      if (resolvedSessionKey) {
        return {
          taskId: task.id,
          action: 'send_to_session',
          targetSessionKey: resolvedSessionKey,
          task,
          reason: `${taskType} task -- resolved session ${resolvedSessionKey} from parentTaskId ${task.parentTaskId}`,
        };
      }
    }

    // No targetSessionKey, no resolvable parent -- fallback to main
    return {
      taskId: task.id,
      action: 'send_to_main',
      task,
      reason: `${taskType} task without targetSessionKey -- fallback to main session`,
    };
  }

  /**
   * Phase 2: Execute a routing decision (performs I/O).
   */
  async execute(decision: RoutingDecision): Promise<RoutingResult> {
    this.logger.info(
      { taskId: decision.taskId, action: decision.action, target: decision.targetSessionKey },
      `Routing decision: ${decision.reason}`,
    );

    let result: RoutingResult;
    try {
      if (decision.action === 'send_to_main') {
        result = await this.sendToMain(decision);
      } else {
        result = await this.sendToSession(decision);
      }
    } catch (error) {
      const errMsg = (error as Error).message;
      this.logger.error({ taskId: decision.taskId, error: errMsg }, 'Routing execution failed');
      result = {
        taskId: decision.taskId,
        success: false,
        action: decision.action,
        error: errMsg,
      };
    }

    this.emit('task_routed', result, decision.reason);

    // Visual terminal output
    printRouteBlock({
      taskId: decision.taskId,
      taskType: decision.task.type || 'new',
      capability: decision.task.capability,
      action: decision.action,
      targetSessionKey: result.sessionKey,
      reason: decision.reason,
      success: result.success,
      fallback: result.fallback,
      error: result.error,
      parentTaskId: decision.task.parentTaskId,
      tracked: result.success && result.action === 'send_to_session',
      sessionAlive: result.fallback ? false : undefined,
      fromBotId: decision.task.fromBotId,
      toBotId: decision.task.toBotId,
      priority: decision.task.priority,
    });

    return result;
  }

  /**
   * Convenience: decide + execute in one call.
   */
  async route(task: Task): Promise<RoutingResult> {
    const decision = this.decide(task);
    return this.execute(decision);
  }

  /**
   * Route a direct_message from the unified inbox.
   *
   * If the message carries a taskId, attempt to route it to the sub-session
   * that is currently handling that task. Falls back to main session when the
   * task is not tracked or the sub-session send fails.
   */
  async routeMessage(message: InboxMessage): Promise<RoutingResult> {
    // taskId present -> try routing to the task's sub-session
    if (message.taskId) {
      let sessionKey = this.sessionTracker.getSessionForTask(message.taskId);

      // Fetch task context (best-effort, non-blocking on failure)
      let task: Task | null = null;
      try {
        task = await this.clawteamApi.getTask(message.taskId);
      } catch {
        this.logger.warn(
          { taskId: message.taskId },
          'Failed to fetch task for message context, continuing without it',
        );
      }

      // API fallback: if in-memory tracker lost the mapping (e.g. gateway restart),
      // recover from task_sessions table using this gateway's botId
      if (!sessionKey && this.botId) {
        this.logger.info(
          { taskId: message.taskId, botId: this.botId },
          'routeMessage: in-memory miss, querying API task_sessions for recovery',
        );
        try {
          const recovered = await this.clawteamApi.getSessionForTaskBot(message.taskId, this.botId);
          if (recovered) {
            sessionKey = recovered;
            this.sessionTracker.track(message.taskId, sessionKey);
            this.logger.info(
              { taskId: message.taskId, sessionKey, botId: this.botId },
              'routeMessage: RECOVERED session mapping from API task_sessions',
            );
          } else {
            this.logger.warn(
              { taskId: message.taskId, botId: this.botId },
              'routeMessage: API task_sessions returned NO mapping for this bot+task',
            );
          }
        } catch (err) {
          this.logger.warn(
            { taskId: message.taskId, botId: this.botId, error: (err as Error).message },
            'routeMessage: API task_sessions query FAILED',
          );
        }
      } else if (!sessionKey && !this.botId) {
        this.logger.warn(
          { taskId: message.taskId },
          'routeMessage: in-memory miss and botId not set — cannot query API fallback',
        );
      }

      if (sessionKey) {
        this.logger.info(
          { messageId: message.messageId, fromBotId: message.fromBotId, taskId: message.taskId, sessionKey },
          'Routing task-context message to sub-session',
        );
        return this.routeMessageToSession(message, sessionKey, task);
      }

      // No tracked session -- fallback to main with task context
      this.logger.info(
        { messageId: message.messageId, fromBotId: message.fromBotId, taskId: message.taskId },
        'Task not tracked in any sub-session, routing task-context message to main',
      );

      const prompt = this.buildTaskContextMessagePrompt(message, task);
      const success = await this.openclawSession.sendToMainSession(prompt);

      const result: RoutingResult = {
        taskId: message.messageId,
        success,
        action: 'send_to_main',
        sessionKey: 'main',
        error: success ? undefined : 'Failed to send task-context message to main session',
      };

      this.emit('message_routed', result);
      this.printDmRouteBlock(message, result);
      return result;
    }

    // No taskId -> existing behaviour: send to main session
    this.logger.info(
      { messageId: message.messageId, fromBotId: message.fromBotId, type: message.type, priority: message.priority },
      'Routing inbox message to main session',
    );

    const prompt = this.buildDirectMessagePrompt(message);
    const success = await this.openclawSession.sendToMainSession(prompt);

    const result: RoutingResult = {
      taskId: message.messageId,
      success,
      action: 'send_to_main',
      sessionKey: 'main',
      error: success ? undefined : 'Failed to send direct message to main session',
    };

    this.emit('message_routed', result);
    this.printDmRouteBlock(message, result);
    return result;
  }
  private async routeMessageToSession(
    message: InboxMessage,
    sessionKey: string,
    task: Task | null,
  ): Promise<RoutingResult> {
    const prompt = this.buildTaskContextMessagePrompt(message, task);
    const success = await this.openclawSession.sendToSession(sessionKey, prompt);

    if (success) {
      const result: RoutingResult = {
        taskId: message.messageId,
        success: true,
        action: 'send_to_session',
        sessionKey,
      };
      this.emit('message_routed', result);
      this.printDmRouteBlock(message, result);
      return result;
    }

    // Sub-session send failed -- fallback to main
    this.logger.warn(
      { messageId: message.messageId, taskId: message.taskId, sessionKey },
      'Send to sub-session failed, falling back to main session',
    );

    const fallbackSuccess = await this.openclawSession.sendToMainSession(prompt);
    const result: RoutingResult = {
      taskId: message.messageId,
      success: fallbackSuccess,
      action: 'send_to_main',
      sessionKey: 'main',
      fallback: true,
      error: fallbackSuccess ? undefined : 'Failed to send task-context message to main session',
    };

    this.emit('message_routed', result);
    this.printDmRouteBlock(message, result);
    return result;
  }

  private printDmRouteBlock(message: InboxMessage, result: RoutingResult): void {
    printRouteBlock({
      taskId: message.messageId,
      taskType: message.type,
      capability: message.taskId ? `task:${message.taskId}` : message.type,
      action: result.action,
      targetSessionKey: result.sessionKey,
      reason: result.fallback ? 'fallback to main' : '',
      success: result.success,
      fallback: result.fallback,
      error: result.error,
      isDm: true,
      fromBotId: message.fromBotId,
      priority: message.priority,
    });
  }

  private buildDirectMessagePrompt(message: InboxMessage): string {
    return [
      '[ClawTeam Message Received]',
      `Message ID: ${message.messageId}`,
      `From Bot: ${message.fromBotId}`,
      `Priority: ${message.priority}`,
      `Content Type: ${message.contentType}`,
      '',
      'Message Content:',
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content, null, 2),
      '',
      'You may respond using:',
      `  curl -s -X POST ${this.gatewayUrl}/gateway/messages/send -H 'Content-Type: application/json' -d '{"toBotId":"${message.fromBotId}","content":"YOUR_REPLY"}'`,
    ].join('\n');
  }

  private buildTaskContextMessagePrompt(message: InboxMessage, task: Task | null): string {
    const lines: string[] = [
      '[ClawTeam Message -- Task Context]',
      `Task ID: ${message.taskId}`,
    ];

    if (task) {
      lines.push(`Capability: ${task.capability}`);
      lines.push(`Task Status: ${task.status}`);
    }

    lines.push(
      `From Bot: ${message.fromBotId}`,
      `Message ID: ${message.messageId}`,
      `Priority: ${message.priority}`,
      '',
      'Message Content:',
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content, null, 2),
    );

    const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'timeout']);
    if (task && TERMINAL_STATES.has(task.status)) {
      lines.push(
        '',
        `NOTE: This task is already in a terminal state (${task.status}). Do NOT send further messages about this task.`,
      );
    } else {
      lines.push(
        '',
        'Reply using:',
        `  curl -s -X POST ${this.gatewayUrl}/gateway/messages/send -H 'Content-Type: application/json' -d '{"toBotId":"${message.fromBotId}","taskId":"${message.taskId}","content":"YOUR_REPLY"}'`,
      );
    }

    return lines.join('\n');
  }

  /**
   * Route a delegate_intent inbox message.
   * Builds the spawn instruction message and sends it to the main session,
   * mirroring the logic previously in router-api.ts POST /delegate-intent.
   */
  async routeDelegateIntent(msg: InboxMessage): Promise<RoutingResult> {
    const { taskId, prompt, capability } = msg.content;
    const fromBotId = msg.fromBotId;

    const message = this.buildDelegateIntentMessage(taskId, prompt, fromBotId);
    const success = await this.openclawSession.sendToMainSession(message);

    const result: RoutingResult = {
      taskId: msg.messageId,
      success,
      action: 'send_to_main',
      sessionKey: 'main',
      error: success ? undefined : 'Failed to send delegate_intent to main session',
    };

    this.emit('task_routed', result, `delegate_intent for task ${taskId}`);

    printRouteBlock({
      taskId: taskId || msg.messageId,
      taskType: 'delegate_intent',
      capability: capability || 'general',
      action: 'send_to_main',
      targetSessionKey: 'main',
      reason: 'delegate_intent from inbox',
      success,
      fromBotId,
      priority: msg.priority,
    });

    return result;
  }

  /**
   * Build the message sent to main session for delegate_intent.
   * The main session will spawn a sender sub-session that queries bots and delegates.
   */
  private buildDelegateIntentMessage(taskId: string, prompt: string, fromBotId: string): string {
    const gw = this.gatewayUrl;
    const intentText = prompt || '';
    const taskIdRef = taskId || 'TASK_ID';

    const spawnParamsLines = taskId
      ? [
          `   task: "You are a ClawTeam delegation proxy. Wait for instructions."`,
          `   label: "${intentText.trim().substring(0, 60)}"`,
          `   _clawteam_role: "sender"`,
          `   _clawteam_taskId: "${taskId}"`,
        ]
      : [
          `   task: "You are a ClawTeam delegation proxy. Wait for instructions."`,
          `   label: "${intentText.trim().substring(0, 60)}"`,
          `   _clawteam_role: "sender"`,
        ];

    const taskIdLine = taskId
      ? `Task ID: ${taskId} (pre-created by dashboard)`
      : 'No taskId yet. The plugin will auto-create it when you spawn with _clawteam_role: "sender".';

    return [
      '[ClawTeam Delegate Intent]',
      `From Bot: ${fromBotId}`,
      `Intent: ${intentText.trim()}`,
      taskIdLine,
      '',
      'ACTION REQUIRED: Delegation flow:',
      '',
      `1. Spawn a sub-session with these params:`,
      ...spawnParamsLines,
      '   The plugin will auto-track the session (and auto-create the task if needed).',
      '',
      '2. Send the delegation + monitoring instructions to the sub-session (below).',
      '',
      '=== SUB-SESSION INSTRUCTIONS (send via sessions_send after spawn) ===',
      '',
      `You are a ClawTeam delegation proxy for the human delegator.`,
      'The human submitted this intent from the dashboard:',
      '',
      `From Bot: ${fromBotId}`,
      `Intent: ${intentText.trim()}`,
      `Task ID: ${taskIdRef}`,
      '',
      'The task record has been created but the executor has NOT been notified yet.',
      'You must delegate the task to deliver it to the executor.',
      '',
      `Step 1: Find a suitable executor bot:`,
      `  curl -s ${gw}/gateway/bots`,
      '',
      `Step 2: Delegate the task to the chosen bot (this sets toBotId, enqueues, and notifies the executor):`,
      `  curl -s -X POST ${gw}/gateway/tasks/${taskIdRef}/delegate -H 'Content-Type: application/json' -d '{"toBotId":"<CHOSEN_BOT_ID>"}'`,
      '',
      'Step 3: Monitor the task. If the executor bot asks questions via DM:',
      '  You are a PROXY for the human delegator. Try to answer from the intent above first.',
      '  If the intent contains the requested information, reply to the executor bot directly.',
      '',
      '  IMPORTANT: Do NOT poll or check task status yourself. The gateway handles polling.',
      '  Just wait for DM messages from the executor bot to arrive in your session.',
      '',
      '  If the intent does NOT contain the requested information:',
      `    1. Call /need-human-input to ask YOUR human user (the delegator's owner):`,
      `       curl -s -X POST ${gw}/gateway/tasks/${taskIdRef}/need-human-input -H 'Content-Type: application/json' -d '{"reason":"<describe what the executor needs>","targetBotId":"${fromBotId}"}'`,
      '       This notifies your human user via the dashboard inbox.',
      '    2. Once your human responds, the system will automatically deliver the answer to the executor.',
      '       You do NOT need to forward anything. Just wait.',
      '    3. Do NOT make up answers or guess information you do not have.',
      '    4. Do NOT send messages to yourself.',
      '    5. Do NOT send repeated status confirmations. One reply per question is enough.',
      '',
      'Do NOT call /complete or /submit-result yourself. Only the executor bot submits results.',
      'Do NOT use curl to check task status. The gateway monitors tasks automatically.',
      '',
      'Step 4: Once the executor bot completes the task, report the task ID and STOP.',
      '  Do NOT send further messages after the task is completed.',
      '  Do NOT engage in pleasantries, confirmations, or goodbyes.',
      '',
      '=== END SUB-SESSION INSTRUCTIONS ===',
    ].join('\n');
  }

  private async sendToMain(decision: RoutingDecision): Promise<RoutingResult> {
    const message = this.buildNewTaskMessage(decision.task);
    const success = await this.openclawSession.sendToMainSession(message, decision.taskId);

    return {
      taskId: decision.taskId,
      success,
      action: 'send_to_main',
      sessionKey: 'main',
      error: success ? undefined : 'Failed to send to main session',
    };
  }

  private async sendToSession(decision: RoutingDecision): Promise<RoutingResult> {
    const targetKey = decision.targetSessionKey!;

    // Check if target session is alive
    const alive = await this.openclawSession.isSessionAlive(targetKey);

    if (alive) {
      const message = this.buildSubTaskMessage(decision.task);
      const success = await this.openclawSession.sendToSession(targetKey, message);

      if (success) {
        this.sessionTracker.track(decision.taskId, targetKey);
        return {
          taskId: decision.taskId,
          success: true,
          action: 'send_to_session',
          sessionKey: targetKey,
        };
      }

      // Send failed on a live session (e.g. CLI timeout because session is busy).
      // Don't fallback to main -- return failure so the poller retries on next cycle.
      // The session will eventually finish its current work and accept the message.
      this.logger.warn(
        { taskId: decision.taskId, targetSessionKey: targetKey },
        'Send to alive session failed (likely busy/timeout), will retry next poll cycle',
      );
      return {
        taskId: decision.taskId,
        success: false,
        action: 'send_to_session',
        sessionKey: targetKey,
        error: 'session_busy',
      };
    } else {
      this.logger.warn(
        { taskId: decision.taskId, targetSessionKey: targetKey },
        'Target session expired, attempting restore before fallback',
      );

      // Try to restore the session before falling back
      if (this.openclawSession.restoreSession) {
        try {
          const restored = await this.openclawSession.restoreSession(targetKey);
          if (restored) {
            this.logger.info(
              { taskId: decision.taskId, targetSessionKey: targetKey },
              'Session restored, retrying send',
            );

            const message = this.buildSubTaskMessage(decision.task);
            const success = await this.openclawSession.sendToSession(targetKey, message);

            if (success) {
              this.sessionTracker.track(decision.taskId, targetKey);
              return {
                taskId: decision.taskId,
                success: true,
                action: 'send_to_session',
                sessionKey: targetKey,
              };
            }
            this.logger.warn(
              { taskId: decision.taskId },
              'Send to restored session failed, continuing to fallback',
            );
          }
        } catch (error) {
          this.logger.warn(
            { taskId: decision.taskId, error: (error as Error).message },
            'Session restore failed',
          );
        }
      }
    }

    // Fallback: session expired or send failed -- route to main with parent context
    const fallbackMessage = await this.buildFallbackMessage(decision.task);
    const fallbackSuccess = await this.openclawSession.sendToMainSession(fallbackMessage, decision.taskId);

    return {
      taskId: decision.taskId,
      success: fallbackSuccess,
      action: 'send_to_main',
      sessionKey: 'main',
      fallback: true,
      error: fallbackSuccess ? undefined : 'Failed to send fallback to main session',
    };
  }

  /**
   * Build message for new tasks routed to main session.
   * Uses param-based flow: spawn with _clawteam_role/_clawteam_taskId params -> plugin auto-tracks -> send details.
   */
  private buildNewTaskMessage(task: Task): string {
    const paramsSection = task.parameters && Object.keys(task.parameters).length > 0
      ? [`Parameters: ${JSON.stringify(task.parameters)}`, '']
      : [];

    return [
      '[ClawTeam Task Received]',
      `Task ID: ${task.id}`,
      `Capability: ${task.capability}`,
      `Type: ${task.type || 'new'}`,
      `From Bot: ${task.fromBotId}`,
      `Priority: ${task.priority}`,
      ...(task.prompt ? [`Prompt: ${task.prompt}`, ''] : ['']),
      '',
      'ACTION REQUIRED: Task execution flow:',
      'DO NOT call any /tasks/ API endpoints yourself. The plugin handles tracking automatically.',
      '',
      `1. Spawn a sub-session with these params:`,
      `   task: "ClawTeam executor task. Task ID: {{TASK_ID}}."`,
      `   label: "${(task.prompt || task.capability || '').slice(0, 60)}"`,
      `   _clawteam_role: "executor"`,
      `   _clawteam_taskId: "${task.id}"`,
      `   _clawteam_from_bot_id: "${task.fromBotId}"`,
      '   The plugin injects the full execution context (rules, API endpoints) automatically.',
      '',
      '2. Then send the task details to the sub-session:',
      '',
      `Task ID: ${task.id}`,
      ...(task.prompt ? [`Prompt: ${task.prompt}`] : []),
      `Capability: ${task.capability}`,
      ...paramsSection,
    ].join('\n');
  }

  private buildSubTaskMessage(task: Task): string {
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
      '',
      `Step 1: Execute the task as described in the Prompt above.`,
      '',
      `CRITICAL RULE: NEVER call /submit-result unless you have actually produced the requested deliverable.`,
      `If you cannot fulfill the request for ANY reason (missing APIs, insufficient permissions, missing info):`,
      `  - Do NOT call /submit-result. No exceptions. A "cannot do" summary is NOT a valid submission.`,
      `  - Instead, follow the information-gathering steps below.`,
      '',
      `INFORMATION GATHERING -- follow this order:`,
      `  1. Task-related info (personal details, preferences, travel dates, names, budgets, etc.)`,
      `     These belong to the DELEGATOR's human user. Ask the delegator bot via DM:`,
      `     curl -s -X POST ${this.gatewayUrl}/gateway/messages/send -H 'Content-Type: application/json' -d '{"toBotId":"${task.fromBotId}","taskId":"${task.id}","content":"YOUR_QUESTION"}'`,
      `     The delegator bot will answer from context or escalate to its own human.`,
      `  2. Executor-specific info (your API keys, system config, tool access, credentials)`,
      `     Only YOUR human user can provide these. Call /need-human-input:`,
      `     curl -s -X POST ${this.gatewayUrl}/gateway/tasks/${task.id}/need-human-input -H 'Content-Type: application/json' -d '{"reason":"DESCRIBE_WHAT_YOU_NEED","targetBotId":"${task.toBotId}"}'`,
      `     This asks YOUR human user only. Then STOP and wait.`,
      `  3. If you are completely blocked and neither approach applies, call /need-human-input as a last resort.`,
      '',
      `Step 2: Submit the result for review:`,
      `  curl -s -X POST ${this.gatewayUrl}/gateway/tasks/${task.id}/submit-result -H 'Content-Type: application/json' -d '{"result":{"summary":"YOUR_OUTPUT"}}'`,
      '',
      `Once submitted, the delegator will review and approve/reject. STOP and wait after submitting.`,
    ].join('\n');
  }

  /**
   * Build fallback message when target session is expired.
   * Uses param-based flow: spawn with _clawteam_role/_clawteam_taskId params -> plugin auto-tracks -> send details.
   */
  private async buildFallbackMessage(task: Task): Promise<string> {
    const taskType = task.type || 'sub-task';
    let parentContext = '';

    if (task.parentTaskId) {
      try {
        const parentTask = await this.clawteamApi.getTask(task.parentTaskId);
        if (parentTask) {
          parentContext = [
            '',
            '--- Parent Task Context ---',
            `Parent Task ID: ${parentTask.id}`,
            `Parent Capability: ${parentTask.capability}`,
            `Parent Status: ${parentTask.status}`,
            parentTask.result
              ? `Parent Result: ${JSON.stringify(parentTask.result)}`
              : '',
          ]
            .filter(Boolean)
            .join('\n');
        }
      } catch (error) {
        this.logger.warn(
          { parentTaskId: task.parentTaskId, error: (error as Error).message },
          'Failed to fetch parent task for fallback context',
        );
      }
    }

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
      'ACTION REQUIRED: Task execution flow:',
      'DO NOT call any /tasks/ API endpoints yourself. The plugin handles tracking automatically.',
      '',
      `1. Spawn a sub-session with these params:`,
      `   task: "ClawTeam executor task. Task ID: {{TASK_ID}}."`,
      `   label: "${(task.prompt || task.capability || '').slice(0, 60)}"`,
      `   _clawteam_role: "executor"`,
      `   _clawteam_taskId: "${task.id}"`,
      `   _clawteam_from_bot_id: "${task.fromBotId}"`,
      '   The plugin injects the full execution context (rules, API endpoints) automatically.',
      '',
      '2. Then send the full task details to the sub-session (below).',
      '',
      '=== SUB-SESSION TASK DETAILS (send via sessions_send after spawn) ===',
      '',
      `You are a ClawTeam sub-session. Execute the ${taskType} task below step by step.`,
      `The task has been auto-accepted by the gateway. Start working immediately.`,
      '',
      `Task ID: ${task.id}`,
      ...(task.prompt ? [`Prompt: ${task.prompt}`] : []),
      `Capability: ${task.capability}`,
      ...(task.parameters && Object.keys(task.parameters).length > 0
        ? [`Parameters: ${JSON.stringify(task.parameters)}`]
        : []),
      parentContext,
      '',
      `Step 1: Execute the task as described in the Prompt above.`,
      '',
      `CRITICAL RULE: NEVER call /submit-result unless you have actually produced the requested deliverable.`,
      `If you cannot fulfill the request for ANY reason (missing APIs, insufficient permissions, missing info):`,
      `  - Do NOT call /submit-result. No exceptions. A "cannot do" summary is NOT a valid submission.`,
      `  - Instead, follow the information-gathering steps below.`,
      '',
      `INFORMATION GATHERING -- follow this order:`,
      `  1. Task-related info (personal details, preferences, travel dates, names, budgets, etc.)`,
      `     These belong to the DELEGATOR's human user. Ask the delegator bot via DM:`,
      `     curl -s -X POST ${this.gatewayUrl}/gateway/messages/send -H 'Content-Type: application/json' -d '{"toBotId":"${task.fromBotId}","taskId":"${task.id}","content":"YOUR_QUESTION"}'`,
      `     The delegator bot will answer from context or escalate to its own human.`,
      `  2. Executor-specific info (your API keys, system config, tool access, credentials)`,
      `     Only YOUR human user can provide these. Call /need-human-input:`,
      `     curl -s -X POST ${this.gatewayUrl}/gateway/tasks/${task.id}/need-human-input -H 'Content-Type: application/json' -d '{"reason":"DESCRIBE_WHAT_YOU_NEED","targetBotId":"${task.toBotId}"}'`,
      `     This asks YOUR human user only. Then STOP and wait.`,
      `  3. If you are completely blocked and neither approach applies, call /need-human-input as a last resort.`,
      '',
      `If you need to delegate part of the work to another bot:`,
      `  curl -s ${this.gatewayUrl}/gateway/bots  (find a bot with matching capability)`,
      `  First create the sub-task:`,
      `  curl -s -X POST ${this.gatewayUrl}/gateway/tasks/create -H 'Content-Type: application/json' -d '{"prompt":"SUB_TASK_DESCRIPTION","type":"sub-task","parentTaskId":"${task.id}"}'`,
      `  Then delegate (use the taskId from the create response):`,
      `  curl -s -X POST ${this.gatewayUrl}/gateway/tasks/SUB_TASK_ID/delegate -H 'Content-Type: application/json' -d '{"toBotId":"BOT_ID"}'`,
      '',
      `Step 2: Submit the result for review:`,
      `  curl -s -X POST ${this.gatewayUrl}/gateway/tasks/${task.id}/submit-result -H 'Content-Type: application/json' -d '{"result":{"summary":"YOUR_OUTPUT"}}'`,
      '',
      `Once submitted, the delegator will review and approve/reject. STOP and wait after submitting.`,
      '',
      '=== END SUB-SESSION TASK DETAILS ===',
    ].join('\n');
  }
}
