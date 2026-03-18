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

/**
 * Build a [CLAWTEAM_META] block to embed in the task string.
 * The plugin parses this to reliably recover role/taskId/fromBotId
 * even when custom params are stripped by OpenClaw.
 */
function buildClawTeamMetaBlock(role: string, taskId?: string, fromBotId?: string): string {
  const lines = ['[CLAWTEAM_META]', `role=${role}`];
  if (taskId) lines.push(`taskId=${taskId}`);
  if (fromBotId) lines.push(`fromBotId=${fromBotId}`);
  lines.push('[/CLAWTEAM_META]');
  return lines.join('\n');
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
   * Task value contains only meta block + task facts. The plugin injects sender-specific rules.
   */
  private buildDelegateIntentMessage(taskId: string, prompt: string, fromBotId: string): string {
    const intentText = prompt || '';
    const taskIdRef = taskId || 'TASK_ID';

    const taskContent = [
      `From Bot: ${fromBotId}`,
      `Intent: ${intentText.trim()}`,
      `Task ID: ${taskIdRef}`,
      '',
      'The task record has been created but the executor has NOT been notified yet.',
      'You must delegate the task to deliver it to the executor.',
    ].join('\n');

    const metaBlock = buildClawTeamMetaBlock('sender', taskId || undefined);
    const taskValue = `${metaBlock}\n${taskContent}`;

    const taskIdLine = taskId
      ? `Task ID: ${taskId} (pre-created by dashboard)`
      : 'No taskId yet. The plugin will auto-create it when spawning.';

    return [
      '[ClawTeam Delegate Intent]',
      `From Bot: ${fromBotId}`,
      `Intent: ${intentText.trim()}`,
      taskIdLine,
      '',
      'ACTION REQUIRED: Spawn a sub-session with these params:',
      '',
      `   task: ${JSON.stringify(taskValue)}`,
      `   label: "${intentText.trim().substring(0, 60)}"`,
      '',
      'Copy the task value exactly as shown above. The plugin handles the rest automatically.',
      'No follow-up sessions_send is needed — all task details are included in the task value.',
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
   * All task details are embedded in the task value — single spawn, no follow-up sessions_send needed.
   */
  private buildNewTaskMessage(task: Task): string {
    const paramsLine = task.parameters && Object.keys(task.parameters).length > 0
      ? `\nParameters: ${JSON.stringify(task.parameters)}`
      : '';

    const taskContent = [
      `Task ID: ${task.id}`,
      ...(task.prompt ? [`Prompt: ${task.prompt}`] : []),
      `Capability: ${task.capability}`,
      ...(paramsLine ? [paramsLine.trim()] : []),
    ].join('\n');

    const executorTaskValue = `${buildClawTeamMetaBlock('executor', task.id, task.fromBotId)}\n${taskContent}`;

    return [
      '[ClawTeam Task Received]',
      `Task ID: ${task.id}`,
      `Capability: ${task.capability}`,
      `Type: ${task.type || 'new'}`,
      `From Bot: ${task.fromBotId}`,
      `Priority: ${task.priority}`,
      ...(task.prompt ? [`Prompt: ${task.prompt}`, ''] : ['']),
      '',
      'ACTION REQUIRED: Spawn a sub-session with these params:',
      'DO NOT call any /tasks/ API endpoints yourself. The plugin handles tracking automatically.',
      '',
      `   task: ${JSON.stringify(executorTaskValue)}`,
      `   label: "${(task.prompt || task.capability || '').slice(0, 60)}"`,
      '',
      'Copy the task value exactly as shown above. The plugin injects execution context automatically.',
      'No follow-up sessions_send is needed — all task details are included in the task value.',
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
    ].join('\n');
  }

  /**
   * Build fallback message when target session is expired.
   * Task value contains only meta block + task facts. The plugin injects executor-specific rules.
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

    const taskContent = [
      `Task ID: ${task.id}`,
      ...(task.prompt ? [`Prompt: ${task.prompt}`] : []),
      `Capability: ${task.capability}`,
      `Type: ${taskType}`,
      `Parent Task: ${task.parentTaskId}`,
      ...(task.parameters && Object.keys(task.parameters).length > 0
        ? [`Parameters: ${JSON.stringify(task.parameters)}`]
        : []),
      parentContext,
    ].join('\n');

    const executorTaskValue = `${buildClawTeamMetaBlock('executor', task.id, task.fromBotId)}\n${taskContent}`;

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
      'ACTION REQUIRED: Spawn a sub-session with these params:',
      'DO NOT call any /tasks/ API endpoints yourself. The plugin handles tracking automatically.',
      '',
      `   task: ${JSON.stringify(executorTaskValue)}`,
      `   label: "${(task.prompt || task.capability || '').slice(0, 60)}"`,
      '',
      'Copy the task value exactly as shown above. The plugin injects execution context automatically.',
      'No follow-up sessions_send is needed — all task details are included in the task value.',
    ].join('\n');
  }
}
