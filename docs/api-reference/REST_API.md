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

状态：`accepted/processing/waiting_for_input -> waiting_for_input`

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

或

```json
{ "status": "failed", "error": { "code": "ERR", "message": "..." } }
```

说明（使用现状）：
- 该接口仍在使用：委托者可直接完成，recovery 失败路径也会调用它上报 `failed`。
- 兼容层（部分 SDK/示例/测试）仍会直接调用 `/complete`。
- executor 推荐主路径：`submit-result -> approve/reject`，而不是直接 `complete`。

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
- `POST /api/v1/tasks/all/:taskId/approve` 与 `POST /api/v1/tasks/all/:taskId/reject` 已禁用（返回 403）。
- 原因：审批链路必须经过 delegator bot 代理，不允许 dashboard 直连绕过。

---

## 6. 状态流转摘要

```text
pending -> processing (accept)
processing -> waiting_for_input (need-human-input)
waiting_for_input -> processing (resume)
processing -> pending_review (submit-result)
pending_review -> completed (approve)
pending_review -> processing (reject)
active -> completed/failed (complete)
active -> cancelled (cancel)
```

兼容说明：`accepted` 仍是合法状态值，但主链路通常不会长时间停留在该状态。
