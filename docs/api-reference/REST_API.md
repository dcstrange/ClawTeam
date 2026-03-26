# REST API 接口规范（2026-03）

## 1. 概述

### Base URL

- API Server: `http://localhost:3000/api/v1`
- Gateway: `http://localhost:3100`

### 认证

受保护接口使用：

```http
Authorization: Bearer <api-key>
```

说明：
- 支持 user-level key 与 bot-level key。
- Dashboard 代表某 bot 操作时，应附加：`X-Bot-Id: <botId>`。

### 响应包结构

```ts
{ success: true, data: T, traceId?: string }
{ success: false, error: { code?: string, message: string }, traceId?: string }
```

---

## 2. 任务生命周期接口

### 2.1 创建与委托

#### `POST /api/v1/tasks/create`

创建任务记录（不入队）。

```json
{
  "prompt": "...",
  "priority": "normal",
  "capability": "general",
  "parameters": {}
}
```

#### `POST /api/v1/tasks/:taskId/delegate-intent`

注册委托意图，写入 inbox，交由 gateway poller 驱动。

#### `POST /api/v1/tasks/:taskId/delegate`

- 直接委托：`{"toBotId":"..."}`
- 子委托：`{"toBotId":"...","subTaskPrompt":"..."}`

子委托会创建新的子任务并返回新的 taskId，且带 `parentTaskId`。

---

### 2.2 接受与执行

#### `POST /api/v1/tasks/:taskId/accept`

`pending -> processing`（已合并 start 语义）。

```json
{ "executorSessionKey": "agent:main:subagent:..." }
```

#### `POST /api/v1/tasks/:taskId/need-human-input`

```json
{ "reason": "需要预算上限", "targetBotId": "optional" }
```

状态：`pending/accepted/processing/waiting_for_input -> waiting_for_input`

#### `POST /api/v1/tasks/:taskId/resume`

```json
{ "input": "预算上限 5000 元", "targetBotId": "optional" }
```

状态：`waiting_for_input -> processing`（或统一 resume 继续流）

---

### 2.3 评审流（推荐）

#### `POST /api/v1/tasks/:taskId/submit-result`

执行者提交结果待审：

```json
{ "result": { "summary": "..." } }
```

状态：`accepted/processing/waiting_for_input -> pending_review`

约束：仅用于最终结论提交。中间进度/提问请走 DM 或 `need-human-input`。

#### `POST /api/v1/tasks/:taskId/approve`

委托者审批通过（可覆盖 result）：

```json
{ "result": { "summary": "final" } }
```

状态：`pending_review -> completed`

#### `POST /api/v1/tasks/:taskId/request-changes`

委托者提出修改意见（软驳回）：

```json
{ "feedback": "请补充边界测试并重提" }
```

状态：`pending_review -> processing`

#### `POST /api/v1/tasks/:taskId/reject`

委托者驳回返工：

```json
{ "reason": "请补充边界情况" }
```

状态：`pending_review -> processing`

---

### 2.4 直接终结（非主路径）

#### `POST /api/v1/tasks/:taskId/complete`

```json
{ "status": "completed", "result": { "summary": "..." } }
```

或（强制结束父任务，忽略未终态子任务门禁）

```json
{ "status": "completed", "force": true, "result": { "summary": "..." } }
```

或

```json
{ "status": "failed", "error": { "code": "ERR", "message": "..." } }
```

说明（使用现状）：
- 该接口仍在使用：委托者可直接完成，recovery 失败路径也会调用它上报 `failed`。
- 兼容层（部分 SDK/示例/测试）仍会直接调用 `/complete`。
- executor 推荐主路径：`submit-result -> approve/request-changes/reject`，而不是直接 `complete`。
- 若存在未终态子任务，`status=completed` 会返回 `409 PENDING_CHILD_TASKS`；可由委托者显式传 `force=true` 覆盖。

#### `POST /api/v1/tasks/:taskId/cancel`

```json
{ "reason": "用户取消" }
```

#### `POST /api/v1/tasks/:taskId/reset`

恢复使用：活跃态重置到 `pending`。

---

## 3. 会话与心跳接口

- `POST /api/v1/tasks/:taskId/heartbeat`
- `PATCH /api/v1/tasks/:taskId/session-key`
- `POST /api/v1/tasks/:taskId/track-session`
- `GET /api/v1/tasks/:taskId/sessions`
- `GET /api/v1/tasks/sessions-by-bot`

---

## 4. 查询接口

- `GET /api/v1/tasks/pending`
- `GET /api/v1/tasks/:taskId`
- `GET /api/v1/tasks`
- `GET /api/v1/tasks/all`（公开，dashboard 用）

---

## 5. Dashboard 管理公开接口

- `POST /api/v1/tasks/all/:taskId/cancel`

说明（2026-03-23）：
- `POST /api/v1/tasks/all/:taskId/approve`、`POST /api/v1/tasks/all/:taskId/request-changes` 与 `POST /api/v1/tasks/all/:taskId/reject` 已禁用（返回 403）。
- 原因：审批链路必须经过 delegator bot 代理，不允许 dashboard 直连绕过。

---

## 6. File Service 接口（`/api/v1/files/*`）

### 6.1 资源管理

- `POST /api/v1/files/folders`
- `POST /api/v1/files/docs`
- `GET /api/v1/files/docs/:docId/raw`
- `PUT /api/v1/files/docs/:docId/raw`
- `POST /api/v1/files/upload`
- `GET /api/v1/files/download/:nodeId`
- `GET /api/v1/files`
- `GET /api/v1/files/:nodeId`
- `POST /api/v1/files/move`
- `POST /api/v1/files/copy`
- `DELETE /api/v1/files/:nodeId`（软删除）

### 6.2 ACL 与发布

- `GET /api/v1/files/acl/:nodeId`
- `POST /api/v1/files/acl/grant`
- `POST /api/v1/files/acl/revoke`
- `POST /api/v1/files/publish`

关键约束：

- bot 默认写入 `bot_private` 或 `task`，不能直接写 `team_shared`。
- `publish` 仅允许 delegator 链路（`fromBotId` 或 owner）执行。
- ACL 判定顺序：`deny > allow > 继承 > namespace 默认策略`。

详见：

- [FILE_SERVICE_API.md](/Users/fei/WorkStation/git/ClawTeam/docs/api-reference/FILE_SERVICE_API.md)
- [openapi-file-service.yaml](/Users/fei/WorkStation/git/ClawTeam/docs/api-reference/openapi-file-service.yaml)
- Swagger UI 运行时入口：`GET /docs`
- OpenAPI 运行时入口：`GET /api/v1/openapi/file-service.yaml`

---

## 7. 状态流转摘要

```text
pending -> processing (accept)
pending/accepted/processing -> waiting_for_input (need-human-input)
waiting_for_input -> processing (resume)
processing -> pending_review (submit-result)
pending_review -> completed (approve)
pending_review -> processing (request-changes)
pending_review -> processing (reject)
active -> completed/failed (complete)
active -> cancelled (cancel)
```

兼容说明：`accepted` 仍是合法状态值，但主链路通常不会长时间停留在该状态。

---

## 8. 调用者与状态校验矩阵（API 真值）

> 口径来源：`packages/api/src/task-coordinator/routes/index.ts` + `completer.ts` + `dispatcher.ts`。
> 下表用于回答“谁在什么状态下可以调用哪些接口”，并明确典型拒绝条件。

| 接口 | 允许调用者 | 允许任务状态 | 典型拒绝条件 |
|------|------|------|------|
| `POST /api/v1/tasks/:taskId/delegate-intent` | `fromBotId`（任务创建者） | 当前实现未做状态限制 | 任务不属于调用 bot |
| `POST /api/v1/tasks/:taskId/delegate`（直接委托） | `fromBotId` | `pending` | 非创建者；状态非 `pending` |
| `POST /api/v1/tasks/:taskId/delegate`（子委托，带 `subTaskPrompt`） | 任务参与者（`fromBotId` 或 `toBotId`） | 父任务非终态（非 `completed/failed/cancelled/timeout`） | 非参与者；父任务已终态 |
| `POST /api/v1/tasks/:taskId/accept` | `toBotId`（执行者） | `pending` | 非执行者；状态非 `pending` |
| `POST /api/v1/tasks/:taskId/need-human-input` | 任务参与者（`fromBotId` 或 `toBotId`） | `pending/accepted/processing/waiting_for_input` | 非参与者；状态不在允许集合 |
| `POST /api/v1/tasks/:taskId/resume` | 任务参与者（`fromBotId` 或 `toBotId`） | `waiting_for_input` 或 `completed/failed/timeout` | 非参与者；状态不在允许集合 |
| `POST /api/v1/tasks/:taskId/submit-result` | `toBotId`（执行者） | `accepted/processing/waiting_for_input`（`pending_review` 重复提交幂等） | 非执行者；状态非法；结果为空 |
| `POST /api/v1/tasks/:taskId/approve` | `fromBotId`（委托者） | `pending_review` | 非委托者；状态非 `pending_review` |
| `POST /api/v1/tasks/:taskId/request-changes` | `fromBotId`（委托者） | `pending_review` | 非委托者；状态非 `pending_review` |
| `POST /api/v1/tasks/:taskId/reject` | `fromBotId`（委托者） | `pending_review` | 非委托者；状态非 `pending_review` |
| `POST /api/v1/tasks/:taskId/complete` | `fromBotId`；或 `toBotId` 仅在上报 `failed` 时 | `pending/accepted/processing/waiting_for_input/pending_review` | 非授权角色；状态不在允许集合；有未终态子任务且未 `force` |
| `POST /api/v1/tasks/:taskId/cancel` | `fromBotId`（委托者） | `pending/accepted/processing/waiting_for_input/pending_review` | 非委托者；状态已终态 |
| `POST /api/v1/tasks/:taskId/reset` | `toBotId`（执行者） | `accepted/processing/waiting_for_input` 且未耗尽重试 | 非执行者；状态非法；超过重试上限 |
| `POST /api/v1/tasks/:taskId/track-session` | 任务参与者（`fromBotId` 或 `toBotId`） | 任意（只要任务存在） | `botId` 冒用；非任务参与者 |
| `POST /api/v1/tasks/all/:taskId/cancel`（公开管理口） | Dashboard/运维调用（非 bot 专属） | `pending/accepted/processing/waiting_for_input/pending_review` | 任务不存在或不可取消 |
| `POST /api/v1/tasks/all/:taskId/approve` / `request-changes` / `reject` | 无（已禁用） | 无 | 固定返回 403（必须走 delegator bot 代理审批） |

补充说明：
- `track-session` 的 `role` 由服务端根据调用者身份推断；body 里的 `role` 仅用于日志告警，不作为信任来源。
- `need-human-input` 允许从 `pending` 直接进入 `waiting_for_input`，并同步补齐 `accepted_at/started_at` 与处理队列索引。
- `accept` 是兜底入口，不是 `need-human-input` 的前置硬条件。
