# Task 操作手册

> 本目录以 Task 为中心，描述当前实现（2026-03）下的生命周期与操作语义。
> 代码基线：`packages/api/src/task-coordinator/routes/index.ts`、`packages/api/src/task-coordinator/completer.ts`。

## Task 状态机

```text
create/delegate
    |
    v
 pending --accept--> processing --submit-result--> pending_review --approve--> completed
    |                    |   ^                            |
    |                    |   |                            +--reject--> processing
    |                    |   +--resume(waiting_for_input) |
    |                    +------need-human-input----------+
    |                                                      
    +------------------------------cancel------------------> cancelled

processing --complete(status=failed)--> failed
processing --timeout------------------> timeout
```

### 状态转换与触发器

| 当前状态 | 触发 | 下一状态 |
|------|------|------|
| - | `create` | `pending` |
| `pending` | `accept` | `processing` |
| `processing` | `need-human-input` | `waiting_for_input` |
| `waiting_for_input` | `resume` | `processing` |
| `accepted/processing/waiting_for_input` | `submit-result` | `pending_review` |
| `pending_review` | `approve` | `completed` |
| `pending_review` | `reject` | `processing` |
| 活跃态 | `complete(status=completed)` | `completed` |
| 活跃态 | `complete(status=failed)` | `failed` |
| 非终态 | `cancel` | `cancelled` |
| 活跃态 | timeout detector | `timeout`（或重试） |

补充说明：
- 术语：`活跃态` 指 `pending/accepted/processing/waiting_for_input/pending_review`；`非终态` 指除 `completed/failed/timeout/cancelled` 外的状态。
- `accepted` 是兼容状态值；当前主路径里 `accept` 直接推进到 `processing`（无独立 `start`）。
- 推荐主路径：执行者 `submit-result` -> 委托者 `approve/reject`。
- `complete` 是直接终结路径，通常不作为主审阅流。

## Task 与 Session 状态关系（概念）

- Task 状态机与 OpenClaw session 状态机是两套并行状态，不是一一对应关系。
- Task 看“业务流程进度”，session 看“LLM 会话运行态”。
- 会出现 `task=processing` 但 `session=idle` 的情况（例如 delegator/sender 监控会话在等待 executor 完成）。
- session `completed/errored/dead` 不会自动把 task 置为终态；是否恢复、nudge、reset 由 Recovery 逻辑决定。

## 操作索引

| 操作 | 触发方式 | 状态变化 | 文档 |
|------|---------|---------|------|
| 创建记录 (`create`) | API / Gateway / Dashboard | 无 → `pending` | [DELEGATE.md](./DELEGATE.md) |
| 注册委托意图 (`delegate-intent`) | Dashboard / API | 状态不变（写入 inbox） | [DASHBOARD_CREATE.md](./DASHBOARD_CREATE.md) |
| 委托 (`delegate`) | Sender / Executor / 任意参与者 | 直接委托不变；子委托创建子任务为 `pending` | [DELEGATE.md](./DELEGATE.md) |
| 路由 (`routing`) | Gateway Poller | 状态不变（投递消息） | [ROUTING.md](./ROUTING.md) |
| 接受 (`accept`) | Executor | `pending` → `processing` | [ACCEPT_START_COMPLETE.md](./ACCEPT_START_COMPLETE.md) |
| 提交结果 (`submit-result`) | Executor | `processing`/`waiting_for_input` → `pending_review` | [ACCEPT_START_COMPLETE.md](./ACCEPT_START_COMPLETE.md) |
| 审批 (`approve`) | Delegator | `pending_review` → `completed` | [ACCEPT_START_COMPLETE.md](./ACCEPT_START_COMPLETE.md) |
| 驳回 (`reject`) | Delegator | `pending_review` → `processing` | [ACCEPT_START_COMPLETE.md](./ACCEPT_START_COMPLETE.md) |
| 直接完成/失败 (`complete`) | Delegator / Executor(失败场景) | 活跃态 → `completed`/`failed` | [ACCEPT_START_COMPLETE.md](./ACCEPT_START_COMPLETE.md) |
| 请求人类输入 (`need-human-input`) | Sender/Executor | 活跃态 → `waiting_for_input` | [NEED_HUMAN_INPUT.md](./NEED_HUMAN_INPUT.md) |
| 恢复 (`resume`) | Dashboard / API | `waiting_for_input` → `processing` | [NEED_HUMAN_INPUT.md](./NEED_HUMAN_INPUT.md) |
| 取消 (`cancel`) | Delegator / Dashboard | 非终态 → `cancelled` | [CANCEL.md](./CANCEL.md) |
| 重置 (`reset`) | Recovery / API | 活跃态 → `pending` | [RESET.md](./RESET.md) |
| 催促 (`nudge`) | Dashboard / Recovery | 状态不变（提醒 session） | [NUDGE.md](./NUDGE.md) |
| 超时 (`timeout`) | TimeoutDetector | 活跃态 → `timeout`（或重试） | [TIMEOUT.md](./TIMEOUT.md) |
| 恢复 (`recovery`) | RecoveryLoop | 视 session 与任务状态而定 | [RECOVERY.md](./RECOVERY.md) |
| 心跳 (`heartbeat`) | HeartbeatLoop | 状态不变（更新心跳元数据） | [HEARTBEAT.md](./HEARTBEAT.md) |

## 关键约束

- 子委托不是 executor 专属；**任务参与者**（`fromBotId` 或 `toBotId`）都可以发起子任务委托。
- 子委托必须绑定父任务：`parentTaskId = 当前任务 ID`。
- 会话追踪使用 `sessionKey + role(sender/executor)`，并和真实 taskId 绑定（含子任务 taskId）。
- `fromBotId` 校验采用“调用方本地 bot 身份必须匹配”策略（plugin + gateway 双重保护）。

## 人类介入代理原则（ClawTeam 设计原则）

- Dashboard 上所有“需要人类介入”的任务消息，必须来自**当前用户自己的 bot**。
- 跨用户 bot 的结果/问题不能直接落到对方人类；必须先经过该人类的 delegator bot 代理转发。
- `submit-result` 后进入 `pending_review` 的审批链路必须由 delegator bot 执行（`approve/reject`），不允许 dashboard 直连绕过。
