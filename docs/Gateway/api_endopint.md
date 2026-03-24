# Gateway HTTP 端点

> ⚠️ Historical Notice: 本文档包含大量调用者盘点与阶段性实现细节，可能存在时效性偏差。
> 当前接口规范请优先参考：`docs/api-reference/api-endpoints.md` 与 `docs/Gateway/GATEWAY_TASK_MANAGEMENT.md`。

> 源码：`packages/clawteam-gateway/src/server/router-api.ts` + `packages/clawteam-gateway/src/gateway/gateway-proxy.ts`

Gateway 在端口 3100 上提供两组 HTTP 端点：

1. **Router API** — Dashboard 管理接口（`router-api.ts`）
2. **Gateway Proxy** — LLM sub-session 的 curl 代理（`gateway-proxy.ts`，路径前缀 `/gateway/*`）

---

## Router API — Dashboard 管理端点

### 监控

| Method | Path | 说明 |
|--------|------|------|
| GET | `/status` | 运行状态（uptime, tracked tasks, active sessions, poller/heartbeat 是否运行） |
| GET | `/sessions` | 所有 session 及其状态 |
| GET | `/sessions/:key` | 单个 session 详情 |
| GET | `/tasks` | 所有 tracked task→session 映射 |
| GET | `/routes/history` | 最近 100 条路由记录 |

**调用者**：

| 端点 | 调用者 |
|------|--------|
| `GET /status` | `dashboard/src/lib/router-api.ts` → `routerApi.getStatus()`；`dashboard/src/hooks/useRouterStatus.ts` → React Query（5s 轮询）；`local-client/src/api/router-client.ts` → `getStatus()` |
| `GET /sessions` | `dashboard/src/lib/router-api.ts` → `routerApi.getSessions()`；`dashboard/src/hooks/useRouterStatus.ts` → React Query；`dashboard/src/pages/Dashboard.tsx`、`TaskDetail.tsx`、`SessionList.tsx` 消费 hook；`local-client/src/api/router-client.ts` → `getSessions()` |
| `GET /sessions/:key` | **无调用者**（已定义但未被任何代码引用） |
| `GET /tasks` | `dashboard/src/lib/router-api.ts` → `routerApi.getTrackedTasks()`；`dashboard/src/hooks/useRouterStatus.ts` → React Query；`local-client/src/api/router-client.ts` → `getTrackedTasks()` |
| `GET /routes/history` | `dashboard/src/lib/router-api.ts` → `routerApi.getRouteHistory()`；`dashboard/src/hooks/useRouterStatus.ts` → React Query；`dashboard/src/pages/RouteHistory.tsx` 消费 hook；`local-client/src/api/router-client.ts` → `getRouteHistory()` |

### 任务管理

| Method | Path | 说明 | 副作用 |
|--------|------|------|--------|
| POST | `/tasks/:taskId/cancel` | 取消任务 | 通知 session + API cancel + untrack |
| POST | `/tasks/:taskId/nudge` | 手动催促 session | 发送 nudge 消息到 session |
| POST | `/tasks/:taskId/resume` | 统一恢复：waiting_for_input 或 completed/failed/timeout | 验证 session 存活（如需）→ API resume → 写 inbox |

**调用者**：

| 端点 | 调用者 |
|------|--------|
| `POST /tasks/:taskId/cancel` | `dashboard/src/lib/router-api.ts` → `routerApi.cancelTask()`（已定义但 UI 未调用，Dashboard 实际使用 API `/api/tasks/all/:id/cancel` 直连）；`local-client/src/api/router-client.ts` → `cancelTask()` |
| `POST /tasks/:taskId/nudge` | `dashboard/src/lib/router-api.ts` → `routerApi.nudgeTask()`；`dashboard/src/components/TaskActions.tsx:62` → nudge 按钮点击处理；`local-client/src/api/router-client.ts` → `nudgeTask()` |
| `POST /tasks/:taskId/resume` | `dashboard/src/lib/router-api.ts` → `routerApi.resumeTask()`（waiting_for_input 恢复）和 `routerApi.continueTask()`（completed/failed 继续，同一端点不同 payload）；`dashboard/src/pages/TaskDetail.tsx:39` → resume 表单提交；`dashboard/src/pages/TaskDetail.tsx:55` → continue 表单提交；`dashboard/src/pages/Inbox.tsx:28` → inbox 项恢复；`dashboard/src/components/TaskActions.tsx:66` → continue 操作；`local-client/src/api/router-client.ts` → `resumeTask()` |

### Session 管理

| Method | Path | 说明 |
|--------|------|------|
| POST | `/sessions/main/reset` | 归档旧 transcript，分配新 session ID |

**调用者**：`dashboard/src/lib/router-api.ts` → `routerApi.resetMainSession()`；`dashboard/src/pages/Dashboard.tsx:25` → reset 按钮处理；`local-client/src/api/router-client.ts` → `resetMainSession()`

### 委托

| Method | Path | 说明 |
|--------|------|------|
| POST | `/delegate-intent` | ~~已删除~~ — 改为 inbox 驱动，见 API Server `POST /api/v1/tasks/:taskId/delegate-intent` |

**新流程（inbox 驱动）**：

```
Dashboard → API POST /api/v1/tasks/create → taskId
Dashboard → API POST /api/v1/tasks/:taskId/delegate-intent → 写 delegate_intent 到 fromBotId inbox
    ↓
Gateway poll inbox → 发现 delegate_intent → router.routeDelegateIntent() → sendToMainSession(spawn 指令)
    ↓
main session spawn sub-session (sender role) → 插件 auto-track
    → sub-session curl /gateway/bots → 选择 executor
    → sub-session curl /gateway/tasks/:taskId/delegate {toBotId}
```

**调用者**：无直接调用者（已删除）。Dashboard 改为调用 API Server `/api/v1/tasks/:taskId/delegate-intent`。

### WebSocket

| Path | 说明 |
|------|------|
| `/ws` | 实时事件推送（最多 10 连接，idle 60s 超时） |

**调用者**：`dashboard/src/hooks/useRouterWebSocket.ts:19` → `new WebSocket(ROUTER_WS_URL/router-ws)`（Vite 代理将 `/router-ws` 重写为 `/ws` 转发到 3100）；`local-client/src/api/router-client.ts:89` → `new WebSocket(baseUrl/ws)` via `connectWs()`

**事件类型**：

| 事件 | 触发时机 |
|------|---------|
| `task_routed` | 任务路由完成 |
| `session_state_changed` | session 状态变化（heartbeat 检测） |
| `poll_complete` | 一次轮询完成 |

---

## Gateway Proxy — LLM curl 代理端点

所有 `/gateway/*` 请求自动注入认证头：

```
Authorization: Bearer <apiKey>
X-Bot-Id: <botId>
```

所有响应通过 `response-formatter.ts` 转为纯文本，方便 LLM 读取。

### Bot 管理

| Method | Path | 代理到 | 说明 |
|--------|------|--------|------|
| POST | `/gateway/register` | API `/api/v1/bots/register` | 注册 bot，自动保存 botId 到 config.yaml 并热更新内存中所有组件的 botId |
| GET | `/gateway/bots` | API `/api/v1/bots` | 列出所有 bot |
| GET | `/gateway/bots/:botId` | API `/api/v1/bots/:botId` | 获取 bot 详情 |

**调用者**：

| 端点 | 调用者 |
|------|--------|
| `POST /gateway/register` | **无代码调用者**。仅 `SKILL.md` curl 文档供 LLM 参考 |
| `GET /gateway/bots` | **Prompt 模板**：`routing/router.ts:616` → fallback 委托 prompt；`server/router-api.ts:425` → delegate-intent prompt；`openclaw-plugin/task_system_prompt_sender.md` → 插件注入 sender sub-session 的 prompt。**文档**：`SKILL.md` curl 示例 |
| `GET /gateway/bots/:botId` | **无代码调用者**。仅 `SKILL.md` curl 文档供 LLM 参考 |

### 任务生命周期

| Method | Path | 代理到 | 副作用 |
|--------|------|--------|--------|
| POST | `/gateway/tasks/create` | API `/api/v1/tasks/create` | 纯 DB 创建，不入队不通知 |
| POST | `/gateway/tasks/:id/delegate` | API `/api/v1/tasks/:id/delegate` | 设置 toBotId + 入队 + 通知 |
| POST | `/gateway/track-session` | 内部处理 | 纯 track（所有角色一致） |
| POST | `/gateway/tasks/:id/accept` | API accept (pending→processing) | 跟踪 session（fallback，插件已处理） |
| POST | `/gateway/tasks/:id/complete` | API complete | sessionTracker.untrack() |
| POST | `/gateway/tasks/:id/cancel` | API cancel (public) | sessionTracker.untrack() |
| POST | `/gateway/tasks/:id/need-human-input` | API waitForInput | 无 |
| POST | `/gateway/tasks/:id/resume` | API resume | 统一 resume + continue |
| GET | `/gateway/tasks/pending` | API pending tasks | 无 |
| GET | `/gateway/tasks/:id` | API task detail | 无 |

**调用者**：

| 端点 | 调用者 |
|------|--------|
| `POST /gateway/tasks/create` | **Dashboard**：`dashboard/src/lib/router-api.ts` → `routerApi.createTask()`；、`dashboard/src/components/CreateTaskModal.tsx:39` → 任务创建流程第 1 步。<br />**插件**：`openclaw-plugin/index.ts:89` → auto-tracker 为 sender role 自动创建 task。<br />**local-client**：`local-client/src/api/router-client.ts:67` → `createTask()`。<br />**Prompt 模板**：`routing/router.ts:618` → sub-delegation prompt；`task_system_prompt_executor.md` → 插件注入 executor prompt |
| `POST /gateway/tasks/:id/delegate` | **Prompt 模板**：`server/router-api.ts:428` → delegate-intent prompt；`routing/router.ts:620` → fallback 委托 prompt；`task_system_prompt_sender.md` → 插件注入 sender prompt。<br />**文档**：`SKILL.md` curl 示例 |
| `POST /gateway/track-session` | **插件**：`openclaw-plugin/index.ts:176` → auto-tracker `after_tool_call` hook。<br />**Prompt 模板**：`recovery/stale-task-recovery-loop.ts:749` → recovery fallback prompt |
| `POST /gateway/tasks/:id/accept` | **无活跃代码调用者**。保留作为 sub-session 可能调用的 fallback 入口。<br />**文档**：`SKILL.md` curl 示例 |
| `POST /gateway/tasks/:id/complete` | **Prompt 模板**：`routing/router.ts:522,623` → 新任务 prompt 和 fallback prompt；`recovery/stale-task-recovery-loop.ts:715,781` → recovery fallback prompt；`task_system_prompt_executor.md` → 插件注入 executor prompt。<br />**文档**：`SKILL.md` curl 示例 |
| `POST /gateway/tasks/:id/cancel` | **无活跃代码调用者**。仅 `SKILL.md` curl 文档供 LLM 参考 |
| `POST /gateway/tasks/:id/need-human-input` | **Prompt 模板**：`routing/router.ts:517,611` → 新任务 prompt；`recovery/stale-task-recovery-loop.ts:712,776` → recovery fallback prompt；`server/router-api.ts:439` → delegate-intent prompt；`task_system_prompt_executor.md` → 插件注入 executor prompt |
| `POST /gateway/tasks/:id/resume` | **无调用者**。Dashboard 通过 Router API `/tasks/:taskId/resume` 间接到达 API，不走 gateway proxy |
| `GET /gateway/tasks/pending` | **无活跃代码调用者**（TaskPollingLoop 直接调用 ClawTeam API 客户端，不走 gateway proxy）。仅 `SKILL.md` curl 文档供 LLM 参考 |
| `GET /gateway/tasks/:id` | **无活跃代码调用者**。仅 `SKILL.md` curl 文档供 LLM 参考 |

### 消息

| Method | Path | 代理到 | 说明 |
|--------|------|--------|------|
| POST | `/gateway/messages/send` | API messages/send | 发送 DM |
| GET | `/gateway/messages/inbox` | API messages/inbox | 获取收件箱 |
| POST | `/gateway/messages/:id/ack` | API messages/ack | 确认消息 |

**调用者**：

| 端点 | 调用者 |
|------|--------|
| `POST /gateway/messages/send` | **Prompt 模板**：`routing/router.ts:304,340,513,607` → DM 回复和任务通信 prompt；`recovery/stale-task-recovery-loop.ts:772` → recovery fallback prompt；`task_system_prompt_executor.md` → 插件注入 executor prompt。**文档**：`SKILL.md` curl 示例 |
| `GET /gateway/messages/inbox` | **无活跃代码调用者**。仅 `SKILL.md` curl 文档供 LLM 参考 |
| `POST /gateway/messages/:id/ack` | **无活跃代码调用者**。仅 `SKILL.md` curl 文档供 LLM 参考 |

---

### 已废弃端点

| Method | Path | 说明 | 调用者 |
|--------|------|------|--------|
| POST | `/notify/task-accepted` | 旧 MCP Server 通知 | **无活跃调用者**。仅 archived 代码引用 |
| POST | `/notify/task-completed` | 旧 MCP Server 通知 | **无活跃调用者**。仅 archived 代码引用 |

---

## `/gateway/track-session` 详解

这是插件 `clawteam-auto-tracker` 的 `after_tool_call` Hook 调用的核心端点。

**请求体**：

```json
{ "taskId": "uuid", "sessionKey": "agent:main:subagent:uuid", "role": "executor" | "sender" }
```

**所有角色统一处理（纯 track）**：

```
1. sessionTracker.track(taskId, sessionKey)  (如果有 taskId)
```

`role` 参数保留用于日志，不影响逻辑。

---

## 调用者全景表

> D = Dashboard UI，L = local-client，P = openclaw-plugin，R = router.ts prompt，S = recovery prompt，I = router-api.ts prompt，T = task_system_prompt_executor/sender.md，K = SKILL.md（LLM 文档）

| 端点 | D | L | P | R | S | I | T | K |
|------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `GET /status` | Y | Y | - | - | - | - | - | - |
| `GET /sessions` | Y | Y | - | - | - | - | - | - |
| `GET /sessions/:key` | - | - | - | - | - | - | - | - |
| `GET /tasks` | Y | Y | - | - | - | - | - | - |
| `GET /routes/history` | Y | Y | - | - | - | - | - | - |
| `POST /tasks/:id/cancel` | Y* | Y | - | - | - | - | - | - |
| `POST /tasks/:id/nudge` | Y | Y | - | - | - | - | - | - |
| `POST /tasks/:id/resume` | Y | Y | - | - | - | - | - | - |
| `POST /sessions/main/reset` | Y | Y | - | - | - | - | - | - |
| `POST /delegate-intent` | ~~删除~~ | - | - | - | - | - | - | - |
| `WS /ws` | Y | Y | - | - | - | - | - | - |
| `POST /gateway/register` | - | - | - | - | - | - | - | Y |
| `GET /gateway/bots` | - | - | - | Y | - | Y | Y | Y |
| `GET /gateway/bots/:botId` | - | - | - | - | - | - | - | Y |
| `POST /gateway/tasks/create` | - | Y | Y | Y | - | - | Y | Y |
| `POST /gateway/tasks/:id/delegate` | - | - | - | Y | - | Y | Y | Y |
| `POST /gateway/track-session` | - | - | Y | - | Y | - | - | - |
| `POST /gateway/tasks/:id/accept` | - | - | - | - | - | - | - | Y |
| `POST /gateway/tasks/:id/complete` | - | - | - | Y | Y | - | Y | Y |
| `POST /gateway/tasks/:id/cancel` | - | - | - | - | - | - | - | Y |
| `POST /gateway/tasks/:id/need-human-input` | - | - | - | Y | Y | Y | Y | - |
| `POST /gateway/tasks/:id/resume` | - | - | - | - | - | - | - | - |
| `GET /gateway/tasks/pending` | - | - | - | - | - | - | - | Y |
| `GET /gateway/tasks/:id` | - | - | - | - | - | - | - | Y |
| `POST /gateway/messages/send` | - | - | - | Y | Y | - | Y | Y |
| `GET /gateway/messages/inbox` | - | - | - | - | - | - | - | Y |
| `POST /gateway/messages/:id/ack` | - | - | - | - | - | - | - | Y |

> *Y\* = 方法已定义但 UI 实际使用了直连 API 的路径（`/api/tasks/all/:id/cancel`）*

**关键发现**：
1. `GET /sessions/:key` 和 `POST /gateway/tasks/:id/resume` 无任何调用者
2. 多个 `/gateway/*` 端点无直接代码调用者，仅通过 prompt 模板由 LLM session 以 curl 方式调用
3. `/gateway/track-session` 的唯一代码调用者是 `openclaw-plugin` 的 `after_tool_call` hook
4. `POST /delegate-intent` 已删除，改为 inbox 驱动：Dashboard → API `POST /api/v1/tasks/:taskId/delegate-intent` → inbox → Gateway poll
5. Dashboard 不再直接调用 `/gateway/tasks/create`，改为调用 API Server `/api/tasks/create`

---

## 设计说明

**botId 注入**：所有代理请求使用当前 gateway 实例配置的本地 botId（不固定为委托者，也可能是执行者）。API 会按任务参与关系校验权限（`fromBotId` / `toBotId`）。

**botId 热更新**：`/gateway/register` 成功后，通过 `onBotIdChanged` 回调同步更新 `ClawTeamApiClient`、`StaleTaskRecoveryLoop`、`RouterApiServer` 及 gateway-proxy deps 中的 botId，无需重启 Gateway。

**Cancel 端点**：使用公开的 `/api/v1/tasks/all/:id/cancel`（非受保护的 `/api/v1/tasks/:id/cancel`），允许跨 bot 取消任务。

**Accept 端点**：`/gateway/tasks/:id/accept` 保留作为 sub-session 调用的入口。API accept 现在直接 pending → processing（不再有 accepted 中间状态）。API 端幂等处理（已 accept 的任务返回 `TaskAlreadyAcceptedError`）。

**Delegate 端点**：`/gateway/tasks/:id/delegate` 替代了旧的 `/gateway/delegate`（collection 级别）和 `/gateway/tasks/:id/activate`。新端点在已创建的 task 上设置 toBotId，然后入队 + 通知。

**Need-human-input 端点**：API 当前允许 `pending/accepted/processing/waiting_for_input` 调用，不再要求必须先 `accept` 才能进入 `waiting_for_input`。
