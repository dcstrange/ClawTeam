# Routing Layer 架构

> 本文档改为“架构总览 + canonical 索引”。
> 详细行为请以 Gateway 域文档和源码为准，避免多文档漂移。

## 1. 角色与边界

Routing Layer 由本地 Gateway 进程实现，职责是：
- 从 API inbox 拉取任务/消息
- 将任务或消息路由到 OpenClaw main/sub-session
- 维护 taskId ↔ sessionKey 映射
- 进行心跳上报、stale 检测与恢复

不负责：
- 业务权限裁决（在 API Server）
- 最终任务状态机持久化（在 API Server）

## 2. 核心组件

- `TaskPollingLoop`：`packages/clawteam-gateway/src/polling/task-poller.ts`
- `TaskRouter`：`packages/clawteam-gateway/src/routing/router.ts`
- `SessionTracker`：`packages/clawteam-gateway/src/routing/session-tracker.ts`
- `HeartbeatLoop`：`packages/clawteam-gateway/src/monitoring/heartbeat-loop.ts`
- `StaleTaskRecoveryLoop`：`packages/clawteam-gateway/src/recovery/stale-task-recovery-loop.ts`

## 3. 当前委托链路（2026-03）

### 3.1 Dashboard 委托意图

```text
Dashboard
  -> POST /api/v1/tasks/create
  -> POST /api/v1/tasks/:taskId/delegate-intent
API inbox 写入 delegate_intent
  -> Gateway Poller 拉取
  -> TaskRouter.routeDelegateIntent()
  -> 发送 [ClawTeam Delegate Intent] 到 main session
```

`/delegate-intent` Router API 入口已废弃。

### 3.2 子会话与 plugin 协作

- main session 收到任务后调用 `sessions_spawn`
- task value 内包含 `<!--CLAWTEAM:{...}-->` token
- plugin 在 `before_tool_call` 注入 sender/executor 提示词
- plugin 在 curl 调用时注入 `sessionKey/sessionKeyRole`
- gateway 根据 body 自动 track 到真实 taskId（包括子任务）

## 4. 本地 API 面

### 4.1 Router API（管理）

- `GET /status`
- `GET /sessions`
- `GET /tasks`
- `GET /routes/history`
- `POST /tasks/:id/nudge`
- `POST /tasks/:id/cancel`
- `POST /tasks/:id/resume`
- `POST /sessions/main/reset`

### 4.2 Gateway Proxy（LLM curl）

- `/gateway/tasks/create`
- `/gateway/tasks/:taskId/delegate`
- `/gateway/tasks/:taskId/submit-result|approve|request-changes|reject|complete`
- `/gateway/tasks/:taskId/need-human-input|resume|cancel`
- `/gateway/messages/send`
- `/gateway/bots`

## 5. Nudge / Recovery 原则

- Nudge 只提醒，不改任务状态。
- Recovery 会跳过合法等待态（`waiting_for_input`、`pending_review`）以及监控型 sender/delegator session。
- dead session 优先 restore，失败再 reset/fallback。

## 6. Canonical 文档

- `docs/Gateway/GATEWAY_TASK_MANAGEMENT.md`
- `docs/Gateway/TaskRouter.md`
- `docs/Gateway/消息构建器.md`
- `docs/task-operations/README.md`
- `docs/spec/LLM_RETRIEVAL_SPEC.md`
