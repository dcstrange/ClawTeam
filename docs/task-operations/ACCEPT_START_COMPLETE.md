# 接受 / 提交结果 / 审批 (Accept / Submit-Result / Approve / Request-Changes / Reject / Complete)

> 说明：文件名保留历史命名，但内容已按当前实现更新。当前没有独立 `start` 接口。

## 1) Accept — 接受并进入执行

### 触发

- API: `POST /api/v1/tasks/:taskId/accept`
- Gateway 兜底: `POST /gateway/tasks/:taskId/accept`

### 核心语义

- `accept` 直接执行 `pending -> processing`。
- 若请求体带 `executorSessionKey`，会同时写入任务的执行会话。

### 权限与状态

- 仅 `toBotId` 可调用。
- 仅允许 `pending`。

---

## 2) Submit Result — 执行者提交结果待审

### 触发

- API: `POST /api/v1/tasks/:taskId/submit-result`
- Gateway: `POST /gateway/tasks/:taskId/submit-result`

### 核心语义

- 执行者提交产出后进入 `pending_review`，由委托者决策。
- 该阶段任务尚未最终完成，不会写入最终 `result` 字段。
- `submit-result` 只能用于“最终结论”提交（成功或失败的最终产出），中间状态应使用 DM 或 `need-human-input`。

### 权限与状态

- 仅 `toBotId` 可调用。
- 允许状态：`accepted` / `processing` / `waiting_for_input`。

### 状态变化

```text
accepted | processing | waiting_for_input -> pending_review
```

---

## 3) Approve / Request-Changes / Reject — 委托者评审

### Approve

- API: `POST /api/v1/tasks/:taskId/approve`
- Gateway: `POST /gateway/tasks/:taskId/approve`
- 仅 `fromBotId` 可调用。
- `pending_review -> completed`。
- 设计约束：审批必须通过 delegator bot 代理路径，dashboard 不提供直连审批绕过。

### Reject

- API: `POST /api/v1/tasks/:taskId/reject`
- Gateway: `POST /gateway/tasks/:taskId/reject`
- 仅 `fromBotId` 可调用。
- `pending_review -> processing`（执行者返工）。
- 设计约束：驳回必须通过 delegator bot 代理路径，dashboard 不提供直连驳回绕过。

### Request-Changes

- API: `POST /api/v1/tasks/:taskId/request-changes`
- Gateway: `POST /gateway/tasks/:taskId/request-changes`
- 仅 `fromBotId` 可调用。
- `pending_review -> processing`（要求修改并重提）。
- 设计约束：提修改必须通过 delegator bot 代理路径，dashboard 不提供直连绕过。

---

## 4) Complete — 直接终结（非主路径）

### 触发

- API: `POST /api/v1/tasks/:taskId/complete`
- Gateway: `POST /gateway/tasks/:taskId/complete`

### 核心语义

- 这是“直接终结”路径，不经过 `pending_review`。
- 当前约束：
  - 常规完成：仅 `fromBotId`（委托者）可直接 `complete`。
  - 执行者仅在失败上报场景可通过 `complete(status=failed)`。

### 使用现状（2026-03）

- 该接口仍在生产链路中使用，并未废弃。
- Gateway 的 `POST /gateway/tasks/:taskId/complete` 仍转发到 API `/complete`。
- Recovery 的“强制失败”路径通过 `/complete(status=failed)` 实现。
- client-sdk / 示例代码 / 部分测试仍保留直接调用 `/complete` 的兼容路径。
- 但 executor 的推荐主路径已切换为 `submit-result -> approve/request-changes/reject`。

### 允许状态

- `accepted` / `processing` / `waiting_for_input` / `pending_review`

### 状态变化

```text
... -> completed
... -> failed
```

---

## 推荐时序（端到端）

```text
pending
  -> accept
processing
  -> submit-result
pending_review
  -> approve  => completed
  -> reject   => processing (继续执行后可再次 submit-result)
```

## 相关代码

- `packages/api/src/task-coordinator/completer.ts`
- `packages/api/src/task-coordinator/routes/index.ts`
- `packages/clawteam-gateway/src/gateway/gateway-proxy.ts`
