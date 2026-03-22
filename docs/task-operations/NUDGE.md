# 催促 (Nudge)

> Nudge 是“提醒 session 继续执行”的动作，不直接修改任务状态。

## 两种触发方式

### 1) 自动催促（Recovery Loop）

- 入口：`StaleTaskRecoveryLoop`
- stale session 状态集合：`idle | completed | errored | dead`
- 对 `idle/completed/errored`：满足 staleness threshold 且通过 cooldown 才会 nudge
- 对 `dead`：先 restore，再决定 nudge/reset/fallback

### 2) 手动催促（Dashboard）

- 入口：`POST /tasks/:taskId/nudge`（Router API）
- 要求任务被追踪，且状态在 `accepted/processing`

## 自动催促的关键保护

Recovery 不会对以下“合法等待场景”发 nudge：
- `task.status = waiting_for_input`
- `task.status = pending_review`
- sender 监控会话（`sessionKey === senderSessionKey`）
- delegator 监控会话（任务仍在活跃态）

这可以避免“任务还在别人会话里执行，却把当前会话误判为空转”。

## 与恢复（Recovery）的关系

- `nudge` 是 recovery 的一级动作（最轻量）。
- 若 session 为 `dead` 或恢复失败，recovery 会升级到：
  - `restoreSession`
  - `resetTask`（回 pending 让 poller 重投）
  - fallback 到 main

## attempt 语义（当前）

- 非 dead stale session：达到上限不会直接终结任务，会重置计数并继续冷却观察。
- dead session：才会进入“次数耗尽后 fail/cancel”的终结逻辑。

## 代码入口

- `packages/clawteam-gateway/src/recovery/stale-task-recovery-loop.ts`
- `packages/clawteam-gateway/src/recovery/types.ts`
- `packages/clawteam-gateway/src/server/router-api.ts` (`/tasks/:taskId/nudge`)
