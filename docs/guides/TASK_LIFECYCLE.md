# 任务生命周期

> ⚠️ Historical Notice: 本文档含历史语义，可能与当前实现不一致。
> 当前规范请优先参考：`docs/task-operations/README.md`、`docs/api-reference/api-endpoints.md`、`docs/Gateway/GATEWAY_TASK_MANAGEMENT.md`。

> 从委派到完成的完整流程

## 1. 状态机

```
                    cancel (fromBot)
              ┌──────────────────────┐
              │                      ▼
  delegate → pending → accepted → processing → completed
                                            ↘ failed
                                            ↘ timeout
              ↑                                │
              └────── reset (recovery) ────────┘
```

## 2. 状态转换

| 转换 | API | 触发者 | 前置状态 |
|------|-----|--------|---------|
| 创建 | POST /delegate | fromBot | - |
| pending → accepted | POST /:id/accept | toBotId | pending |
| accepted → processing | POST /:id/start | toBotId | accepted |
| → completed | POST /:id/complete | toBotId | accepted/processing |
| → failed | POST /:id/complete (error) | toBotId | accepted/processing |
| → cancelled | POST /:id/cancel | fromBotId | pending/accepted |
| → pending (reset) | POST /:id/reset | toBotId | accepted/processing |
| → timeout | 自动 (TimeoutDetector) | 系统 | processing |
| timeout → pending | 自动 (retryCount < max) | 系统 | timeout |

## 3. 任务类型

| 类型 | 含义 | 路由目标 | 关键参数 |
|------|------|---------|---------|
| `new` | 全新任务 | main session | - |
| `sub-task` | 子任务（后续/修正等） | targetSessionKey 指定的 sub-session | parentTaskId, targetSessionKey |

**路由策略：**
- `new` → `sendToMain()` → main session spawn 子 session 处理
- `sub-task` → `sendToSession(targetSessionKey)` → 直接发到子 session
- 子 session 死亡 → fallback 到 main session

## 4. 关键参数

| 参数 | 设置者 | 用途 |
|------|--------|------|
| `parentTaskId` | Delegator | sub-task 引用的父任务 |
| `senderSessionKey` | Delegator | 委派方的 session key |
| `targetSessionKey` | Delegator (parameters 中) | sub-task 的目标 session |
| `executorSessionKey` | Executor (accept 时) | 执行方的 session key |

## 5. 超时和重试

**TimeoutDetector (API Server 内)：**
- 每 60s 扫描一次
- processing 任务超过 `timeoutSeconds` (默认 3600s) → 标记 timeout
- `retryCount < maxRetries` (默认 3) → 重置为 pending，`retryCount++`
- `retryCount >= maxRetries` → 最终 timeout，发布 `task_failed` 事件

## 6. 优先级

队列排序: `urgent > high > normal > low`

Redis 队列 key: `clawteam:tasks:pending:{toBotId}`

## 7. 完整流程图

```
Bot A                    API Server                ClawTeam Gateway          OpenClaw
  │                         │                          │                      │
  ├─ delegate ─────────────→│                          │                      │
  │                         ├─ 创建任务 (pending)       │                      │
  │                         ├─ 入 Redis 队列           │                      │
  │                         ├─ 发布 task_assigned ────→│(WebSocket)           │
  │                         │                          │                      │
  │                         │←── pollPendingTasks ─────┤                      │
  │                         │──── [task] ─────────────→│                      │
  │                         │                          ├─ route(task) ────────→│
  │                         │                          │  [ClawTeam Task      │
  │                         │                          │   Received]          │
  │                         │                          │                      │
  │                         │                          │                 main session
  │                         │                          │                  spawn sub
  │                         │                          │                      │
  │                         │←──── accept ─────────────┤←─────────────────────┤
  │                         ├─ status: accepted        │                      │
  │                         │                          │                      │
  │                         │←──── start ──────────────┤←─────────────────────┤
  │                         ├─ status: processing      │                      │
  │                         │                          │                      │
  │                         │                          ├─ heartbeat ──────────→│
  │                         │←──── heartbeat ──────────┤  (检查 session 状态)  │
  │                         │                          │                      │
  │                         │←──── complete ───────────┤←─────────────────────┤
  │                         ├─ status: completed       │                      │
  │  ←── task_completed ────┤  (WebSocket)             │                      │
  │                         │                          │                      │
```
