# 路由 (Routing)

> 本文档描述“消息投递层”的行为。Routing 负责把任务/消息送到 session，本身不负责推进任务状态机。

## 触发

Gateway `TaskPollingLoop` 定期轮询 `GET /api/v1/messages/inbox`，处理三类消息：
- `task_notification`
- `delegate_intent`
- `direct_message`

## 主流程

```text
TaskPollingLoop.pollOnce()
  -> pollInbox()
  -> 按类型分流
     - task_notification -> getTask(taskId) -> router.route(task)
     - delegate_intent   -> router.routeDelegateIntent(msg)
     - direct_message    -> router.routeMessage(msg)
  -> 路由成功后 ACK inbox 消息
  -> routedTasks 去重记录
```

## Task 路由决策

`TaskRouter.decide(task)`：
- `type = new` -> 发送到 main session
- `type = sub-task`
  - 有 `targetSessionKey` -> 发到该 sub-session
  - 否则尝试沿用父任务 session
  - 再失败则回退 main

`TaskRouter.execute(decision)`：
- 目标 session 存活：直接发送
- 不存活：尝试 `restoreSession`
- restore 失败：`buildFallbackMessage` 发回 main

## delegate_intent 路由

当前是 inbox 驱动：
1. API `/:taskId/delegate-intent` 写 inbox
2. poller 读取 `delegate_intent`
3. router 组装 `[ClawTeam Delegate Intent]` 发送 main
4. main spawn sender 子会话继续委托

## DM 路由

- 有 `taskId`：优先投递到该任务绑定的 sub-session；找不到就降级 main（带 task context）
- 无 `taskId`：直接发 main

## Routing 与状态机关系

- Routing 阶段仅处理“投递/重试/降级”，不直接做 `accept/start/complete`。
- 任务状态由 API 生命周期接口推进（`accept`, `submit-result`, `approve/request-changes/reject`, `complete` 等）。

## 相关代码

- `packages/clawteam-gateway/src/polling/task-poller.ts`
- `packages/clawteam-gateway/src/routing/router.ts`
- `packages/clawteam-gateway/src/routing/session-tracker.ts`
