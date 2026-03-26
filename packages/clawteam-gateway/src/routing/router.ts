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
import type { ISessionClient, IMessageBuilder } from '../providers/types.js';
import type { SessionTracker } from './session-tracker.js';
import type { Logger } from 'pino';
import { printRouteBlock } from '../utils/visual-log.js';

export interface TaskRouterDeps {
  clawteamApi: IClawTeamApiClient;
  sessionClient: ISessionClient;
  sessionTracker: SessionTracker;
  messageBuilder: IMessageBuilder;
  logger: Logger;
  gatewayUrl: string;
  botId?: string;
}

export class TaskRouter extends EventEmitter {
  private readonly clawteamApi: IClawTeamApiClient;
  private readonly sessionClient: ISessionClient;
  private readonly sessionTracker: SessionTracker;
  private readonly messageBuilder: IMessageBuilder;
  private readonly logger: Logger;
  private readonly gatewayUrl: string;
  private readonly botId?: string;

  constructor(deps: TaskRouterDeps) {
    super();
    this.clawteamApi = deps.clawteamApi;
    this.sessionClient = deps.sessionClient;
    this.sessionTracker = deps.sessionTracker;
    this.messageBuilder = deps.messageBuilder;
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

      const prompt = await this.buildTaskContextMessagePrompt(message, task);
      const success = await this.sessionClient.sendToMainSession(prompt);

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
    const success = await this.sessionClient.sendToMainSession(prompt);

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
    const prompt = await this.buildTaskContextMessagePrompt(message, task);
    const success = await this.sessionClient.sendToSession(sessionKey, prompt);

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

    const fallbackSuccess = await this.sessionClient.sendToMainSession(prompt);
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

  private async buildTaskContextMessagePrompt(message: InboxMessage, task: Task | null): Promise<string> {
    const lines: string[] = [
      '[ClawTeam Message -- Task Context]',
      `Task ID: ${message.taskId}`,
    ];

    if (task) {
      lines.push(`Capability: ${task.capability}`);
      lines.push(`Task Status: ${task.status}`);
    }

    let fromBotName = '';
    let fromOwner = '';
    try {
      const fromBot = await this.clawteamApi.getBot(message.fromBotId);
      if (fromBot) {
        fromBotName = fromBot.name || '';
        fromOwner = fromBot.ownerEmail || '';
      }
    } catch {
      // best-effort enrichment
    }

    lines.push(
      `From Bot: ${message.fromBotId}`,
      `From Bot Name: ${fromBotName || 'unknown'}`,
      `From Owner: ${fromOwner || 'unknown'}`,
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
    const content = (msg.content && typeof msg.content === 'object')
      ? (msg.content as Record<string, any>)
      : {};
    const taskId = typeof content.taskId === 'string' ? content.taskId : '';
    let prompt = typeof content.prompt === 'string' ? content.prompt : '';
    let capability = typeof content.capability === 'string' ? content.capability : '';
    let parameters = (content.parameters && typeof content.parameters === 'object')
      ? (content.parameters as Record<string, any>)
      : {};
    const fromBotId = msg.fromBotId;

    // Authoritative sync: delegate_intent should follow the live task row.
    // This prevents stale inbox payloads from mixing taskId with another prompt.
    if (taskId) {
      try {
        const liveTask = await this.clawteamApi.getTask(taskId);
        if (liveTask) {
          const livePrompt = typeof liveTask.prompt === 'string' ? liveTask.prompt : '';
          if (livePrompt && prompt.trim() && livePrompt.trim() !== prompt.trim()) {
            this.logger.warn(
              { taskId, inboxPrompt: prompt, livePrompt },
              'delegate_intent prompt mismatch; using live task prompt',
            );
          }
          if (livePrompt.trim()) {
            prompt = livePrompt;
          }

          capability = liveTask.capability || capability;
          if (liveTask.parameters && typeof liveTask.parameters === 'object') {
            parameters = liveTask.parameters as Record<string, any>;
          }
        }
      } catch (error) {
        this.logger.warn(
          { taskId, error: (error as Error).message },
          'delegate_intent live task sync failed; using inbox payload',
        );
      }
    }

    const toMeta = await this.resolveDelegateIntentTarget(prompt, parameters);
    const message = this.messageBuilder.buildDelegateIntentMessage(taskId, prompt, fromBotId, toMeta);
    const success = await this.sessionClient.sendToMainSession(message);

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

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private firstNonEmptyString(...values: unknown[]): string {
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
    return '';
  }

  private extractToBotIdFromIntent(intentText: string): string {
    const match = intentText.match(/Delegate\s+a\s+task\s+to\s+bot\s+([^\s:]+)\s*:/i);
    return match?.[1]?.trim() || '';
  }

  private async resolveDelegateIntentTarget(
    prompt: string,
    parameters: Record<string, any>,
  ): Promise<{ toBotId?: string; toBotName?: string; toBotOwner?: string }> {
    const top = this.asRecord(parameters);
    const delegateIntent = this.asRecord(top?.delegateIntent);
    const dashboardDelegate = this.asRecord(top?.dashboardDelegate);

    const toBotId = this.firstNonEmptyString(
      top?.toBotId,
      top?.targetBotId,
      delegateIntent?.toBotId,
      delegateIntent?.targetBotId,
      dashboardDelegate?.toBotId,
      dashboardDelegate?.targetBotId,
      this.extractToBotIdFromIntent(prompt || ''),
    );

    let toBotName = this.firstNonEmptyString(
      top?.toBotName,
      top?.targetBotName,
      delegateIntent?.toBotName,
      delegateIntent?.targetBotName,
      dashboardDelegate?.toBotName,
      dashboardDelegate?.targetBotName,
    );

    let toBotOwner = this.firstNonEmptyString(
      top?.toBotOwner,
      top?.targetBotOwner,
      top?.toOwner,
      delegateIntent?.toBotOwner,
      delegateIntent?.targetBotOwner,
      delegateIntent?.toOwner,
      dashboardDelegate?.toBotOwner,
      dashboardDelegate?.targetBotOwner,
      dashboardDelegate?.toOwner,
    );

    if (toBotId && (!toBotName || !toBotOwner)) {
      try {
        const bot = await this.clawteamApi.getBot(toBotId);
        if (bot) {
          if (!toBotName && bot.name) toBotName = bot.name;
          if (!toBotOwner && bot.ownerEmail) toBotOwner = bot.ownerEmail;
        }
      } catch {
        // best-effort lookup
      }
    }

    return {
      ...(toBotId ? { toBotId } : {}),
      ...(toBotName ? { toBotName } : {}),
      ...(toBotOwner ? { toBotOwner } : {}),
    };
  }

  private async sendToMain(decision: RoutingDecision): Promise<RoutingResult> {
    // Look up delegator bot name for context
    let fromBotName: string | undefined;
    try {
      const fromBot = await this.clawteamApi.getBot(decision.task.fromBotId);
      fromBotName = fromBot?.name;
    } catch { /* best-effort */ }

    const message = this.messageBuilder.buildNewTaskMessage(decision.task, fromBotName);
    const success = await this.sessionClient.sendToMainSession(message, decision.taskId);

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
    const alive = await this.sessionClient.isSessionAlive(targetKey);

    if (alive) {
      const message = this.messageBuilder.buildSubTaskMessage(decision.task);
      const success = await this.sessionClient.sendToSession(targetKey, message);

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
      if (this.sessionClient.restoreSession) {
        try {
          const restored = await this.sessionClient.restoreSession(targetKey);
          if (restored) {
            this.logger.info(
              { taskId: decision.taskId, targetSessionKey: targetKey },
              'Session restored, retrying send',
            );

            const message = this.messageBuilder.buildSubTaskMessage(decision.task);
            const success = await this.sessionClient.sendToSession(targetKey, message);

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
    // Pre-fetch parent context (was previously inside buildFallbackMessage)
    let parentContext: string | undefined;
    if (decision.task.parentTaskId) {
      try {
        const parentTask = await this.clawteamApi.getTask(decision.task.parentTaskId);
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
          { parentTaskId: decision.task.parentTaskId, error: (error as Error).message },
          'Failed to fetch parent task for fallback context',
        );
      }
    }
    const fallbackMessage = this.messageBuilder.buildFallbackMessage(decision.task, parentContext);
    const fallbackSuccess = await this.sessionClient.sendToMainSession(fallbackMessage, decision.taskId);

    return {
      taskId: decision.taskId,
      success: fallbackSuccess,
      action: 'send_to_main',
      sessionKey: 'main',
      fallback: true,
      error: fallbackSuccess ? undefined : 'Failed to send fallback to main session',
    };
  }

}
