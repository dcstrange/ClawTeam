# TaskRouter — 路由决策与执行

> 源码：`packages/clawteam-gateway/src/routing/router.ts`

## 职责

TaskRouter 负责两类路由：
- `task_notification`（任务消息）
- `direct_message` / `delegate_intent`（消息与委托意图）

并在完成后发出 `task_routed` / `message_routed` 事件给 Dashboard WebSocket。

## 两阶段模型

| 阶段 | 方法 | 说明 |
|------|------|------|
| 决策 | `decide(task)` | 纯逻辑选择目标 session |
| 执行 | `execute(decision)` | 发送消息、失败恢复、降级 |

## 任务路由规则

```text
type = new
  -> send_to_main

type = sub-task
  -> 有 targetSessionKey: send_to_session(target)
  -> 否则若有 parentTaskId: 尝试沿用父任务 session
  -> 否则: send_to_main
```

### 会话失效处理

当目标 sub-session 不可用：
1. 尝试 `restoreSession()`
2. 仍失败则降级到 main（`buildFallbackMessage`）
3. 保留父任务上下文，避免任务信息丢失

## delegate_intent 路由（新链路）

当前不再走 Router API `POST /delegate-intent`。

真实链路：
1. Dashboard 调 API `POST /api/v1/tasks/:taskId/delegate-intent`
2. API 写 `delegate_intent` 到 inbox
3. Poller 读到后调用 `routeDelegateIntent(msg)`
4. Router 构建 `[ClawTeam Delegate Intent]` 并发送到 main

`routeDelegateIntent` 会尽力补全：
- `fromBotName/fromBotOwner`
- `toBotId/toBotName/toBotOwner`

并写入 `<!--CLAWTEAM:{...}-->` token，交给 plugin 注入 sender 提示词。

## DM 路由规则

- 有 `taskId`：优先路由到 `sessionTracker` 对应 sub-session；找不到则降级 main（携带 task context）。
- 无 `taskId`：直接发到 main。

## 事件

| 事件 | 触发时机 | 数据 |
|------|---------|------|
| `task_routed` | task/delegate_intent 路由完成 | `{taskId, action, sessionKey, success, reason}` |
| `message_routed` | DM 路由完成 | `{messageId, taskId, sessionKey, success}` |

## 当前实现注意点

- 不再依赖 `[CLAWTEAM_META]`、`_clawteam_*`。
- 统一使用 `<!--CLAWTEAM:{...}-->`。
- `accept/start` 不在 Router 中连调；accept 语义已并入 `pending -> processing`。
