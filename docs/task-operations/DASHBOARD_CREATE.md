# Dashboard 手动创建任务

> 本文档描述 Dashboard Create Task Modal 的当前实现（inbox 驱动委托）。

## 触发

操作者在 Dashboard `CreateTaskModal` 提交：
- `fromBotId`（委托者）
- `toBotId`（预选执行者）
- `prompt` / `capability` / `priority`

## 实际链路

```text
Dashboard CreateTaskModal
  |
  | 1) POST /api/tasks/create
  |    (proxy -> API /api/v1/tasks/create)
  |    body: {
  |      prompt: "Delegate a task to bot <toBotId>: ...",
  |      priority,
  |      capability?,
  |      parameters: {
  |        delegateIntent: {
  |          toBotId,
  |          toBotName,
  |          toBotOwner,
  |          source: "dashboard_create_task_modal"
  |        }
  |      }
  |    }
  |
  | 2) POST /api/tasks/:taskId/delegate-intent
  |    (proxy -> API /api/v1/tasks/:taskId/delegate-intent)
  v
API 写入 delegate_intent inbox 消息
  v
Gateway Poller 拉到 delegate_intent
  v
TaskRouter.routeDelegateIntent()
  v
发送 [ClawTeam Delegate Intent] 到 main session
  v
main session 执行 sessions_spawn（task value 含 <!--CLAWTEAM:{...}-->）
  v
plugin 注入 sender 子会话系统提示
  v
sender 子会话调用 /gateway/tasks/:taskId/delegate 委托给执行者
```

## 关键变化（相对旧文档）

- 不再使用 Router API `POST /delegate-intent`。
- 不再使用 `SPAWN_RESULT` stdout 解析链路。
- 不再要求 follow-up `sessions_send`；task value 已包含完整上下文。
- intent 文案会补全并透传 `toBotId/toBotName/toBotOwner`，用于 sender 提示词中显示“目标执行者”。

## 鉴权与身份

- Dashboard 调 API 使用用户 API Key（Bearer）。
- `fromBotId` 通过 `X-Bot-Id` 传给 API，确保权限校验落到正确 bot。

## 相关代码

- `packages/dashboard/src/components/CreateTaskModal.tsx`
- `packages/dashboard/src/lib/router-api.ts`
- `packages/api/src/task-coordinator/routes/index.ts` (`/:taskId/delegate-intent`)
- `packages/clawteam-gateway/src/routing/router.ts` (`routeDelegateIntent`, `buildDelegateIntentMessage`)
