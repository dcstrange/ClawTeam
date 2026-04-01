/**
 * Provider Abstraction — Core Interface Definitions
 *
 * 定义 provider-neutral 的接口，使任何 session provider（OpenClaw、Claude Code 等）
 * 都能即插即用地接入 ClawTeam Gateway。
 *
 * 添加新 provider 的步骤：
 * 1. 创建 providers/<name>/ 目录
 * 2. 实现 ISessionClient, IMessageBuilder, ISessionResolver（可选）
 * 3. 在 provider-factory.ts 的 createProvider() switch 中添加 case
 * 4. 在 SessionProviderType 联合中添加类型值
 * 5. 在 config.ts 的 YamlConfig 中添加 provider 专属配置节
 */

import type { Task } from '@clawteam/shared/types';
import type { TaskSessionStatus } from '../monitoring/types.js';

// ── Provider Type ──────────────────────────────────────────────

/** 已实现的 session provider 类型。未来可扩展（如 'cursor', 'windsurf' 等）。 */
export type SessionProviderType = 'openclaw' | 'claude';

// ── ISessionClient ─────────────────────────────────────────────

/**
 * ISessionClient — 消息投递与 session 生命周期管理。
 *
 * Provider 实现此接口来处理向 LLM session 发送消息、检测 session 存活状态等。
 * 方法签名从原 IOpenClawSessionClient 直接继承，仅去除 "OpenClaw" 命名前缀。
 *
 * 必须方法：sendToSession, sendToMainSession, isSessionAlive
 * 可选方法（非所有 provider 都支持）：restoreSession, resolveSessionKeyFromId, resetMainSession
 */
export interface ISessionClient {
  /**
   * 向指定 session 发送消息。
   * @param sessionKey - provider 特定的 session 标识符
   *   （OpenClaw: "agent:<agentId>:<type>:<uuid>"，Claude: "claude:<sessionId>"）
   * @param message - 要发送的消息文本
   * @returns true 如果消息发送成功（或至少进入了发送队列）
   */
  sendToSession(sessionKey: string, message: string): Promise<boolean>;

  /**
   * 向主 session 发送消息。
   * @param message - 消息文本
   * @param taskId - 可选的 task ID，用于日志关联
   */
  sendToMainSession(message: string, taskId?: string): Promise<boolean>;

  /**
   * 检测指定 session 是否存活。
   * 实现方式因 provider 而异：OpenClaw 使用 HTTP 状态 API，Claude 使用文件 mtime 或 SDK。
   */
  isSessionAlive(sessionKey: string): Promise<boolean>;

  /**
   * 尝试恢复一个已归档/孤立的 session。
   * 并非所有 provider 都支持此操作。
   * @returns true 如果 session 恢复成功
   */
  restoreSession?(sessionKey: string): Promise<boolean>;

  /**
   * 反向查找：给定原始 session ID（UUID），返回对应的 session key。
   * 用于将外部传入的 raw ID 映射到 provider 内部的 key 格式。
   */
  resolveSessionKeyFromId?(sessionId: string): string | undefined;

  /**
   * 重置主 session（通过 gateway 调用 provider 的 reset 机制）。
   * @returns 新 session ID 或 null（如果 reset 失败）
   */
  resetMainSession?(): Promise<string | null>;
}

// ── ISessionResolver ───────────────────────────────────────────

/**
 * ISessionResolver — Session 状态检测与发现。
 *
 * 从 SessionStatusResolver 抽象出 provider-neutral 的两个核心方法。
 * 用于心跳循环和恢复循环中批量解析 session 状态。
 *
 * 注意：router-api.ts 的调试端点（/sessions、/sessions/:key）调用的
 * resolveAllSessions()、fetchCliSessions()、resolveOne() 是 OpenClaw 专属方法，
 * 不纳入此抽象接口。这些端点通过 SessionProvider.concreteResolver 访问。
 */
export interface ISessionResolver {
  /** 解析所有可见 session 的状态（用于心跳循环的全量扫描）。 */
  resolveAll(): Promise<TaskSessionStatus[]>;

  /**
   * 解析指定 task-session 对的状态（用于恢复循环的精确查询）。
   * @param pairs - 要检查的 taskId-sessionKey 对列表
   */
  resolveForTasks(
    pairs: Array<{ taskId: string; sessionKey: string }>,
  ): Promise<TaskSessionStatus[]>;
}

// ── IMessageBuilder ────────────────────────────────────────────

/**
 * 用于 buildDelegateIntentMessage 的委派目标信息。
 * 从 router.ts 的 resolveDelegateIntentTarget() 返回值抽象。
 */
export interface DelegateTarget {
  toBotId?: string;
  toBotName?: string;
  toBotOwner?: string;
}

/**
 * IMessageBuilder — 生成 provider 特定的 LLM 指令消息。
 *
 * 实现类在构造时接收 `gatewayUrl` 等不变参数，方法签名中不重复传递。
 * 所有方法均为同步（返回 string）。需要异步获取的数据（如父任务上下文）
 * 由调用方预取后作为参数传入。
 *
 * OpenClaw 实现生成 sessions_spawn / sessions_send 指令 + CLAWTEAM 元数据 token。
 * Claude 实现生成 Agent tool 指令（无 CLAWTEAM token，使用 hook 机制追踪）。
 */
export interface IMessageBuilder {
  /**
   * 新任务 → 主 session（告诉 LLM 如何 spawn 子会话）。
   * 映射自: router.ts buildNewTaskMessage()
   *
   * 实现应同时包含 cleanPromptForExecutor() 辅助逻辑：
   * 清除委派前缀（"Delegate a task to bot <UUID>:"）和 "Prompt:" 前缀。
   *
   * @param task - 新任务对象
   * @param fromBotName - 发送方 bot 的显示名称（可选，由调用方预取）
   */
  buildNewTaskMessage(task: Task, fromBotName?: string): string;

  /**
   * 子任务 → 目标 session（直接在已有 session 中执行）。
   * 映射自: router.ts buildSubTaskMessage()
   */
  buildSubTaskMessage(task: Task): string;

  /**
   * delegate intent → 主 session（告诉 LLM 代理委派任务）。
   * 映射自: router.ts buildDelegateIntentMessage()
   *
   * @param taskId - 预创建的 task ID（可为空字符串）
   * @param prompt - 委派意图文本
   * @param fromBotId - 发起委派的 bot ID
   * @param target - 委派目标信息（toBotId, toBotName, toBotOwner）
   */
  buildDelegateIntentMessage(
    taskId: string,
    prompt: string,
    fromBotId: string,
    target: DelegateTarget,
  ): string;

  /**
   * Session 过期 fallback → 主 session（重新派发任务到新 session）。
   * 映射自: router.ts buildFallbackMessage()
   *
   * 注意：原方法是 async（内部调用 getTask 获取父任务上下文）。
   * 抽象后改为 sync：调用方（TaskRouter.execute）负责预取 parentContext，
   * 将结果作为参数传入。
   *
   * @param task - 需要重新派发的任务
   * @param parentContext - 预取的父任务上下文字符串（可选）
   */
  buildFallbackMessage(task: Task, parentContext?: string): string;

  /**
   * 恢复循环 fallback → 主 session（恢复尝试耗尽后重新派发任务）。
   * 映射自: stale-task-recovery-loop.ts buildFallbackMessage()
   *
   * 与上面的 buildFallbackMessage 是不同的消息格式：
   * - router 版本：简洁的 spawn 指令 + 任务元数据
   * - recovery 版本：完整的三步流程（spawn → track → send details）
   */
  buildRecoveryFallbackMessage(task: Task): string;

  /**
   * 恢复循环 nudge → stale session（提醒继续工作）。
   * 映射自: stale-task-recovery-loop.ts buildNudgeMessage()
   *
   * 参数映射（注意与原方法签名有重排序）:
   *   原: (taskId, sessionKey, sessionState, task, attemptNum)
   *   新: (taskId, task, sessionState, attemptNum, maxAttempts)
   *
   * 变更说明:
   *   - sessionKey: 在消息文本中未使用，故删除
   *   - task: 从第 4 位提前到第 2 位（与其他 IMessageBuilder 方法签名风格一致）
   *   - maxAttempts: 原通过 this.attemptTracker['maxAttempts'] 内部访问，
   *                  现改为显式参数（解耦 builder 对 recovery loop 内部状态的依赖）
   */
  buildNudgeMessage(
    taskId: string,
    task: Task,
    sessionState: string,
    attemptNum: number,
    maxAttempts: number,
  ): string;
}

// ── ProviderConfig ─────────────────────────────────────────────

/**
 * Provider 配置（从 GatewayConfig 中分离的 provider 专属部分）。
 * 未来可扩展为各 provider 的配置 schema。
 */
export interface ProviderConfig {
  type: SessionProviderType;
  /** 主 session 的标识（provider 自行定义格式） */
  mainSessionKey: string;
  /** Provider 特定的配置选项 */
  providerOptions: Record<string, unknown>;
}
