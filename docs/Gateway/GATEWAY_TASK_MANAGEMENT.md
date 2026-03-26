# Gateway 任务状态管理

> 目标：给出当前实现（2026-03）的统一口径，避免历史方案与现行逻辑混淆。

## 架构总览

Gateway 位于 API Server 与本地 OpenClaw session 之间，核心由 4 类循环/组件协同：

- `TaskPollingLoop`：轮询 inbox，路由 `task_notification/direct_message/delegate_intent`
- `TaskRouter`：构建消息并投递到 main 或 sub-session
- `HeartbeatLoop`：上报 session 心跳与状态
- `StaleTaskRecoveryLoop`：stale 检测与恢复（nudge / restore / reset / fallback）

`SessionTracker` 维护 taskId ↔ sessionKey 映射，`RoutedTasksTracker` 防重复路由。

## Task 状态机（Gateway 视角）

```text
pending --accept--> processing --submit-result--> pending_review --approve--> completed
   |                       |                              |
   |                       +--need-human-input--> waiting_for_input --resume--+
   +--need-human-input--------------------------------------------------------+
   |                                                                              |
   +----------------------------------------------cancel--------------------------+

pending_review --request-changes--> processing
pending_review --reject--> processing
processing --complete(failed)--> failed
processing --timeout--> timeout
```

说明：
- Gateway 负责路由、监控、恢复，不直接“定义”状态机；状态机真值在 API（task-coordinator）。
- 当前实现中 `accept` 直接把任务推进到 `processing`。
- 当前实现中 `need-human-input` 也可从 `pending` 直接进入 `waiting_for_input`（由 API 补齐 start 相关字段）。

## Session 状态与 Task 状态关系

Session 状态来源于 `SessionStatusResolver`：`active/tool_calling/waiting/idle/completed/errored/dead/unknown`。  
Task 状态来源于 API：`pending/accepted/processing/waiting_for_input/pending_review/completed/failed/timeout/cancelled`。

两者是并行状态，不是一一映射。下面是 Gateway 的处理关系：

| 典型组合 | 是否异常 | Gateway 行为 |
|------|------|------|
| `task=processing` + `session=active/tool_calling/waiting` | 否 | 正常执行，跳过恢复 |
| `task=processing` + `session=idle`（短时） | 否 | 低于阈值不处理 |
| `task=processing` + `session=idle/completed/errored`（超阈值） | 可能异常 | 进入 nudge/cooldown 逻辑 |
| `task=processing` + `session=dead` | 异常 | restore -> reset -> fallback |
| `task=waiting_for_input` + 任意 stale session | 否（合法等待） | Recovery 跳过 |
| `task=pending_review` + 任意 stale session | 否（合法等待审批） | Recovery 跳过 |
| `task in {pending,accepted,processing,waiting_for_input,pending_review}` + `sender/delegator 监控 session=idle` | 否（正常） | Recovery 跳过 |
| `task=completed/failed/timeout/cancelled` + 任意 session | 终态 | 清理/取消追踪 |

关键结论：
- 会出现 `session=idle` 但 `task` 仍在跑（尤其是委托方监控会话）。
- `session=completed` 不等于 `task=completed`；任务是否完成以 task 状态为准。
- Nudge 只提醒 session，不直接修改 task 状态。

## 当前任务创建与委托模型

### A. 预创建 + 委托（推荐）

1. `POST /gateway/tasks/create`（仅建记录，不入队）
2. `POST /gateway/tasks/:taskId/delegate`（设置 toBot、入队、发通知）

### B. 子委托（sub-task）

在 `POST /gateway/tasks/:taskId/delegate` 里携带 `subTaskPrompt`，API 会：
- 以当前任务为父任务创建子任务（新 taskId）
- `parentTaskId = 当前 taskId`
- 立即 delegate 给目标 bot

权限语义：
- 直接委托（无 `subTaskPrompt`）：仅原始委托者可操作 pending 任务
- 子委托（有 `subTaskPrompt`）：任务参与者（`fromBotId`/`toBotId`）均可发起

## 身份与安全校验

### `fromBotId` 一致性

`/gateway/tasks/:taskId/delegate` 若 body 声明 `fromBotId`，必须等于 gateway 本地 botId，否则 403。

### sender 身份一致性（plugin）

plugin 在 sender spawn 前验证：
- token 里的 `fromBotId` 必须与本地 botId 一致
- 不一致则 block spawn

### 防自委托

`toBotId === 本地 botId` 时 gateway 拒绝（400）。

## Gateway 入口的调用约束（对齐 API 真值）

> Gateway 代理层做“身份兜底”，最终状态权限仍以 API 校验为准。

| Gateway 接口 | Gateway 侧约束 | API 侧关键约束（最终生效） |
|------|------|------|
| `POST /gateway/tasks/:taskId/delegate` | 若 body 含 `fromBotId`，必须等于本地 botId；并禁止 `toBotId === 本地 botId` | 直接委托：仅 `fromBotId` 且 `pending`；子委托：参与者可发起，父任务必须非终态 |
| `POST /gateway/tasks/:taskId/accept` | 自动携带本地 bot 身份；可自动补 `executorSessionKey` | 仅 `toBotId` 可调；状态必须 `pending` |
| `POST /gateway/tasks/:taskId/need-human-input` | 自动携带本地 bot 身份；支持幂等提示和冲突纠正文案 | 仅参与者可调；状态允许 `pending/accepted/processing/waiting_for_input` |
| `POST /gateway/tasks/:taskId/submit-result` | 空结果会在 gateway 层先拦截 | 仅 `toBotId` 可调；状态 `accepted/processing/waiting_for_input` |
| `POST /gateway/tasks/:taskId/approve` / `request-changes` / `reject` | 自动携带本地 bot 身份 | 仅 `fromBotId` 可调；状态必须 `pending_review` |
| `POST /gateway/tasks/:taskId/complete` | 对 executor 返回清晰错误提示（应走 submit-result） | `fromBotId` 可完成；`toBotId` 仅可上报失败；状态须活跃 |
| `POST /gateway/tasks/:taskId/reset` | 无额外网关特殊逻辑 | 仅 `toBotId` 可调；需未耗尽重试配额 |
| `POST /gateway/track-session` | 仅负责绑定映射，不推进任务状态 | API 会校验调用者必须是任务参与者，并按调用者推断 role |

补充：
- `track-session` 与 plugin auto-track 只做 session 绑定，不自动 `accept` 任务。
- 因此“任务开始执行”与“session 已绑定”是两个并行事件，不能互相替代。

## 插件协作（openclaw-plugin）

当前插件机制：
- 识别 `<!--CLAWTEAM:{...}-->` token（兼容旧 marker）
- `before_tool_call(sessions_spawn)`：
  - sender 无 taskId 时自动调用 `/gateway/tasks/create`
  - 注入 sender/executor 子会话模板
- `before_tool_call(curl)`：自动把 `sessionKey/sessionKeyRole` 注入 JSON body
- `tool_result_persist`：在 spawn 结果追加 taskId

不再使用：
- `_clawteam_*` spawn 参数约定
- `[CLAWTEAM_META]` 文本块
- 依赖 `SPAWN_RESULT` 的 stdout 链接机制

## Gateway Proxy 关键端点（`/gateway/*`）

| Method | Path | 说明 |
|------|------|------|
| POST | `/gateway/tasks/create` | 仅创建任务记录 |
| POST | `/gateway/tasks/:taskId/delegate` | 直接委托或子委托 |
| POST | `/gateway/tasks/:taskId/accept` | 兜底 accept（pending->processing） |
| POST | `/gateway/tasks/:taskId/submit-result` | 执行者提交待审 |
| POST | `/gateway/tasks/:taskId/approve` | 委托者审批通过 |
| POST | `/gateway/tasks/:taskId/request-changes` | 委托者提出修改意见 |
| POST | `/gateway/tasks/:taskId/reject` | 委托者驳回返工 |
| POST | `/gateway/tasks/:taskId/complete` | 直接终结（委托者主用） |
| POST | `/gateway/tasks/:taskId/need-human-input` | 标记等待人类输入 |
| POST | `/gateway/tasks/:taskId/resume` | 恢复继续 |
| POST | `/gateway/tasks/:taskId/cancel` | 取消并清理跟踪 |
| POST | `/gateway/track-session` | 显式 track（纯绑定） |
| POST | `/gateway/messages/send` | Bot 间消息 |
| GET | `/gateway/bots` | 列 bot |
| GET | `/gateway/tasks/:taskId` | 查任务 |

关于 `/complete` 的现状：
- `/complete` 仍在用，不是废弃接口。
- 主要用于 delegator 直接终结任务、以及 recovery 的失败落地（`status=failed`）。
- executor 正常交付路径应走 `/submit-result` 后等待 `approve/request-changes/reject`。

## Router API（Dashboard 管理端）

| Method | Path | 说明 |
|------|------|------|
| GET | `/status` | Router 状态 |
| GET | `/sessions` | 已追踪 session |
| GET | `/tasks` | 已追踪任务 |
| GET | `/routes/history` | 路由历史 |
| POST | `/tasks/:taskId/nudge` | 手动催促 |
| POST | `/tasks/:taskId/cancel` | 手动取消编排 |
| POST | `/tasks/:taskId/resume` | resume 编排 |
| POST | `/sessions/main/reset` | 重置 main session |

说明：`POST /delegate-intent` 已废弃并移除，现由 API inbox 驱动。

## Recovery/Nudge 当前原则

- Nudge 只“提醒 session 继续工作”，不改任务状态。
- Recovery 会跳过合法等待场景：
  - `waiting_for_input`
  - `pending_review`
  - sender 监控会话
  - delegator 监控会话（任务仍活跃）
- 非 dead stale session 达到最大次数后不会直接终结任务，而是冷却后继续监控。
- dead session 才会进入 restore/reset/fallback 及最终 exhausted 终结路径。

## 代码入口

- `packages/clawteam-gateway/src/polling/task-poller.ts`
- `packages/clawteam-gateway/src/routing/router.ts`
- `packages/clawteam-gateway/src/gateway/gateway-proxy.ts`
- `packages/clawteam-gateway/src/recovery/stale-task-recovery-loop.ts`
- `packages/openclaw-plugin/index.ts`
