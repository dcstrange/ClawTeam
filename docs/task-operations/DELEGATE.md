# 创建与委托 (Create / Delegate)

> 当前实现将“创建记录”和“实际委托”拆成两步。

## 1) 创建任务记录

### 接口

- API: `POST /api/v1/tasks/create`
- Gateway: `POST /gateway/tasks/create`

### 语义

- 仅写入 `tasks` 记录，初始 `status = pending`。
- 此时通常 `toBotId` 仍为空（等待后续 delegate）。
- 不入任务队列，不写 task_notification inbox。

---

## 2) 执行委托

### 接口

- API: `POST /api/v1/tasks/:taskId/delegate`
- Gateway: `POST /gateway/tasks/:taskId/delegate`

### 两种模式

#### 直接委托（direct）

```json
{ "toBotId": "<BOT_ID>" }
```

- 使用现有 taskId，设置目标执行者并入队。
- 仅原始委托者可对 pending 任务执行 direct delegate。

#### 子委托（sub-task）

```json
{ "toBotId": "<BOT_ID>", "subTaskPrompt": "<子任务描述>" }
```

- 由 API 自动创建子任务（新 taskId）。
- `parentTaskId = 当前任务 ID`。
- 子任务再被 delegate 给目标 bot。
- 任务参与者（`fromBotId`/`toBotId`）都可发起。

---

## 3) 会话绑定与身份校验

### 会话绑定

- plugin 会在 curl body 自动注入 `sessionKey`。
- gateway 在 delegate 时会把会话绑定到“真实被委托的 taskId”（对子委托即子任务 ID）。

### 身份校验

- `/gateway/tasks/:taskId/delegate` 若 body 带 `fromBotId`，必须与本地 botId 一致。
- sender spawn 也会在 plugin 层校验 `fromBotId === 本地 botId`。

---

## 4) 状态变化

```text
create:      无 -> pending
delegate:    pending (保持)
accept后:    pending -> processing
```

> 委托动作本身不把任务推进到 processing；processing 由执行者 accept 触发。

## 5) 相关代码

- `packages/api/src/task-coordinator/dispatcher.ts`
- `packages/api/src/task-coordinator/routes/index.ts`
- `packages/clawteam-gateway/src/gateway/gateway-proxy.ts`
- `packages/openclaw-plugin/index.ts`
