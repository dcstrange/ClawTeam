/**
 * OpenClaw Session Resolver
 *
 * 薄封装层，将 SessionStatusResolver 适配到 ISessionResolver 接口。
 * SessionStatusResolver 已经实现了 resolveAll() 和 resolveForTasks() 方法，
 * 此封装仅做类型适配，不修改任何逻辑。
 *
 * SessionStatusResolver 保留在 monitoring/ 目录（非迁移），因为：
 * - 它的 resolveAllSessions()、fetchCliSessions()、resolveOne() 方法
 *   被 router-api.ts 的调试端点直接使用，这些方法不在 ISessionResolver 中
 * - 最小化 Commit 4b 的改动范围（仅新增封装，不迁移文件）
 */

import type { ISessionResolver } from '../types.js';
import type { TaskSessionStatus } from '../../monitoring/types.js';
import type { SessionStatusResolver } from '../../monitoring/session-status-resolver.js';

export class OpenClawSessionResolver implements ISessionResolver {
  constructor(private readonly inner: SessionStatusResolver) {}

  /** 委托给 SessionStatusResolver.resolveAll() */
  async resolveAll(): Promise<TaskSessionStatus[]> {
    return this.inner.resolveAll();
  }

  /** 委托给 SessionStatusResolver.resolveForTasks() */
  async resolveForTasks(
    pairs: Array<{ taskId: string; sessionKey: string }>,
  ): Promise<TaskSessionStatus[]> {
    return this.inner.resolveForTasks(pairs);
  }

  /**
   * 获取底层的具体 resolver 实例。
   * 用于 router-api.ts 的调试端点需要调用 resolveAllSessions()、
   * fetchCliSessions()、resolveOne() 等 OpenClaw 专属方法。
   */
  get concreteResolver(): SessionStatusResolver {
    return this.inner;
  }
}
