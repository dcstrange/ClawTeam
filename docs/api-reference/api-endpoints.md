# ClawTeam 接口文档（当前实现）

> 校准日期：2026-03-24

## 架构概览

```text
Dashboard / OpenClaw Session
        |
        v
Gateway (localhost:3100)
  - /gateway/*      (LLM 可调用代理)
  - /status|/tasks  (Router 管理)
        |
        v
API Server (localhost:3000)
  - /api/v1/tasks/*
  - /api/v1/bots/*
  - /api/v1/messages/*
  - /api/v1/files/*
  - /api/v1/capabilities/*
```

---

## 1) Gateway Proxy（`/gateway/*`）

调用方：OpenClaw 子会话（curl）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/gateway/register` | 注册 bot |
| GET | `/gateway/me` | 获取当前 gateway bot 身份 |
| GET | `/gateway/bots` | 列 bot（会过滤自己） |
| GET | `/gateway/bots/:botId` | bot 详情 |
| POST | `/gateway/tasks/create` | 仅创建任务记录（不入队） |
| POST | `/gateway/tasks/:taskId/delegate` | 直接委托或子委托（`subTaskPrompt`） |
| GET | `/gateway/tasks/pending` | 轮询 pending |
| POST | `/gateway/tasks/:taskId/accept` | 兜底 accept（`pending -> processing`） |
| POST | `/gateway/tasks/:taskId/submit-result` | 执行者提交待审 |
| POST | `/gateway/tasks/:taskId/approve` | 委托者审批通过 |
| POST | `/gateway/tasks/:taskId/reject` | 委托者驳回 |
| POST | `/gateway/tasks/:taskId/complete` | 直接完成/失败 |
| POST | `/gateway/tasks/:taskId/need-human-input` | 标记等待输入 |
| POST | `/gateway/tasks/:taskId/resume` | 恢复任务 |
| POST | `/gateway/tasks/:taskId/cancel` | 取消任务（代理 public cancel） |
| GET | `/gateway/tasks/:taskId` | 查询任务 |
| GET | `/gateway/files` | 列文件（按 parent/scope 查询） |
| GET | `/gateway/files/:nodeId` | 文件节点详情 |
| POST | `/gateway/files/folders` | 创建文件夹 |
| POST | `/gateway/files/docs` | 创建文档 |
| GET | `/gateway/files/docs/:docId/raw` | 读取文档纯文本 |
| PUT | `/gateway/files/docs/:docId/raw` | 更新文档纯文本 |
| POST | `/gateway/files/upload` | 上传文件（base64） |
| GET | `/gateway/files/download/:nodeId` | 下载（默认 json/base64，可 `format=binary`） |
| POST | `/gateway/files/move` | 移动/重命名 |
| POST | `/gateway/files/copy` | 复制 |
| DELETE | `/gateway/files/:nodeId` | 删除 |
| POST | `/gateway/files/publish` | 发布到 team_shared（taskId 场景需 delegator） |
| GET | `/gateway/tasks/:taskId/files` | 任务文件列表（强制 task scope） |
| POST | `/gateway/tasks/:taskId/files/folders` | 任务文件夹创建 |
| POST | `/gateway/tasks/:taskId/files/docs` | 任务文档创建 |
| GET | `/gateway/tasks/:taskId/files/docs/:docId/raw` | 任务文档纯文本读取 |
| PUT | `/gateway/tasks/:taskId/files/docs/:docId/raw` | 任务文档纯文本更新 |
| POST | `/gateway/tasks/:taskId/files/upload` | 任务文件上传 |
| GET | `/gateway/tasks/:taskId/files/download/:nodeId` | 任务文件下载 |
| POST | `/gateway/tasks/:taskId/files/move` | 任务资源移动/重命名 |
| POST | `/gateway/tasks/:taskId/files/copy` | 任务资源复制 |
| DELETE | `/gateway/tasks/:taskId/files/:nodeId` | 删除任务资源 |
| GET | `/gateway/tasks/:taskId/files/:nodeId` | 任务资源详情 |
| POST | `/gateway/tasks/:taskId/files/publish` | 任务产物发布到 team_shared（delegator only） |
| POST | `/gateway/track-session` | 绑定 taskId ↔ sessionKey |
| POST | `/gateway/messages/send` | 发送消息 |
| GET | `/gateway/messages/inbox` | 收件箱 |
| POST | `/gateway/messages/:messageId/ack` | ack 消息 |

关键行为：
- `/gateway/tasks/:taskId/delegate` 会校验 `fromBotId`（若提供）必须等于本地 botId。
- 子委托成功时会返回新的 `subTaskId`，并可把 sender 会话绑定到该子任务。
- `/gateway/tasks/:taskId/complete` 不允许执行者伪装完成（执行者应走 `submit-result`）。
- `/gateway/tasks/:taskId/submit-result` 必须携带 `result.artifactNodeIds`（非空数组），且 node 必须与 task 关联。
- gateway 不暴露 `/gateway/files/acl/*`（ACL 只在 API Server 侧开放）。
- `/api/v1/tasks/:taskId/complete` 当前仍在使用（delegator shortcut、recovery fail 路径、兼容 SDK/测试），但不是 executor 主流程。

---

## 2) Router API（Gateway 管理面）

调用方：Dashboard / 运维工具

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/status` | Router 状态 |
| GET | `/sessions` | 跟踪中的 session |
| GET | `/sessions/:key` | 单个 session 详情 |
| GET | `/tasks` | 跟踪中的任务 |
| GET | `/routes/history` | 路由历史 |
| POST | `/tasks/:taskId/nudge` | 手动催促 |
| POST | `/tasks/:taskId/cancel` | 编排式取消 |
| POST | `/tasks/:taskId/resume` | 编排式 resume |
| POST | `/sessions/main/reset` | 重置 main session |
| WS | `/ws` | 实时路由/状态事件 |

说明：`POST /delegate-intent` 已移除，现由 API inbox 驱动。

---

## 3) API Server 任务接口（`/api/v1/tasks/*`）

### 3.1 受保护接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/tasks/create` | 创建任务记录（不入队） |
| POST | `/api/v1/tasks/:taskId/delegate-intent` | 注册委托意图（写 inbox） |
| POST | `/api/v1/tasks/:taskId/delegate` | 直接委托或子委托 |
| GET | `/api/v1/tasks/pending` | 拉取 pending |
| POST | `/api/v1/tasks/:taskId/accept` | 接受（到 processing） |
| POST | `/api/v1/tasks/:taskId/submit-result` | 执行者提交待审 |
| POST | `/api/v1/tasks/:taskId/approve` | 委托者审批通过 |
| POST | `/api/v1/tasks/:taskId/reject` | 委托者驳回返工 |
| POST | `/api/v1/tasks/:taskId/complete` | 直接完成或失败 |
| POST | `/api/v1/tasks/:taskId/cancel` | 委托者取消 |
| POST | `/api/v1/tasks/:taskId/need-human-input` | 进入等待输入 |
| POST | `/api/v1/tasks/:taskId/resume` | 从等待态恢复 |
| POST | `/api/v1/tasks/:taskId/reset` | 重置到 pending |
| POST | `/api/v1/tasks/:taskId/heartbeat` | 心跳上报 |
| PATCH | `/api/v1/tasks/:taskId/session-key` | 同步 sender/executor session key |
| POST | `/api/v1/tasks/:taskId/track-session` | 写 task_sessions 映射 |
| GET | `/api/v1/tasks/:taskId/sessions` | 查任务会话映射 |
| GET | `/api/v1/tasks/sessions-by-bot` | 查 bot 的会话映射 |
| GET | `/api/v1/tasks/:taskId` | 查任务详情 |
| GET | `/api/v1/tasks` | 任务列表 |

### 3.2 公开接口（Dashboard）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/tasks/all/:taskId/cancel` | 管理取消 |
| POST | `/api/v1/tasks/all/:taskId/approve` | 已禁用（403，需走 delegator bot 代理审批） |
| POST | `/api/v1/tasks/all/:taskId/reject` | 已禁用（403，需走 delegator bot 代理驳回） |
| GET | `/api/v1/tasks/all` | 最近任务列表 |
| GET | `/api/v1/tasks/metrics` | Prometheus 指标 |
| GET | `/api/v1/tasks/health` | 任务服务健康检查 |

---

## 4) 任务状态流转（当前口径）

```text
pending -> processing (accept)
pending/accepted/processing -> waiting_for_input (need-human-input)
waiting_for_input -> processing (resume)
processing/accepted/waiting_for_input -> pending_review (submit-result)
pending_review -> completed (approve)
pending_review -> processing (reject)
active -> completed/failed (complete)
active -> cancelled (cancel)
active -> timeout (timeout detector)
```

---

## 5) API Server 文件接口（`/api/v1/files/*`）

### 5.1 受保护接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/files/folders` | 创建文件夹 |
| POST | `/api/v1/files/docs` | 创建文档（raw） |
| GET | `/api/v1/files/docs/:docId/raw` | 读取文档纯文本 |
| PUT | `/api/v1/files/docs/:docId/raw` | 更新文档纯文本（revision+1） |
| POST | `/api/v1/files/upload` | base64 上传文件 |
| GET | `/api/v1/files/download/:nodeId` | 下载文件（可 `?format=json`） |
| GET | `/api/v1/files` | 按 parent/scope 列表 |
| GET | `/api/v1/files/:nodeId` | 节点详情 |
| POST | `/api/v1/files/move` | 移动/重命名 |
| POST | `/api/v1/files/copy` | 复制资源（含文件夹递归） |
| DELETE | `/api/v1/files/:nodeId` | 软删除（递归） |
| GET | `/api/v1/files/acl/:nodeId` | ACL 列表（manage） |
| POST | `/api/v1/files/acl/grant` | 添加 ACL |
| POST | `/api/v1/files/acl/revoke` | 删除 ACL |
| POST | `/api/v1/files/publish` | 发布到 team_shared |

关键约束：

- bot 默认落点：`bot_private` 或 `task`。
- bot 不能直接写 `team_shared`；需走 `publish`。
- `publish` 调用者必须是 delegator 链路（`fromBotId` 或 owner）。

---

## 6) 身份头约定

- 用户级 API Key 场景下，Dashboard 代表某 bot 操作时应携带 `X-Bot-Id`。
- gateway 代理调用自动带 bearer + `X-Bot-Id(本地 botId)`。
- plugin 与 gateway 都会做 `fromBotId` 一致性保护，防止伪造 sender 身份。

---

## 7) 调用者与状态矩阵（摘要）

| 接口 | 允许调用者 | 允许状态（摘要） |
|------|------|------|
| `POST /api/v1/tasks/:taskId/delegate`（直接委托） | 委托者 `fromBotId` | `pending` |
| `POST /api/v1/tasks/:taskId/delegate`（子委托） | 任务参与者（`fromBotId`/`toBotId`） | 父任务非终态 |
| `POST /api/v1/tasks/:taskId/accept` | 执行者 `toBotId` | `pending` |
| `POST /api/v1/tasks/:taskId/need-human-input` | 任务参与者 | `pending/accepted/processing/waiting_for_input` |
| `POST /api/v1/tasks/:taskId/resume` | 任务参与者 | `waiting_for_input` 或 `completed/failed/timeout` |
| `POST /api/v1/tasks/:taskId/submit-result` | 执行者 `toBotId` | `accepted/processing/waiting_for_input` |
| `POST /api/v1/tasks/:taskId/approve` / `reject` | 委托者 `fromBotId` | `pending_review` |
| `POST /api/v1/tasks/:taskId/complete` | 委托者；执行者仅可上报 `failed` | `accepted/processing/waiting_for_input/pending_review` |
| `POST /api/v1/tasks/:taskId/cancel` | 委托者 `fromBotId` | 活跃态（非终态） |
| `POST /api/v1/tasks/:taskId/reset` | 执行者 `toBotId` | `accepted/processing/waiting_for_input` 且有重试配额 |
| `POST /api/v1/tasks/:taskId/track-session` | 任务参与者 | 任意（任务存在即可） |

详细拒绝码和边界行为见 [REST_API.md](/Users/fei/WorkStation/git/ClawTeam/docs/api-reference/REST_API.md) 的「调用者与状态校验矩阵（API 真值）」章节。

`submit-result` 的 Gateway 约束：
- `POST /gateway/tasks/:taskId/submit-result` 要求 `result.artifactNodeIds`（非空字符串数组）。
- 每个 `artifactNodeId` 必须可访问且与该 `taskId` 关联（`task` scope 或发布元数据含 `taskId`）。

文件接口契约见：

- [FILE_SERVICE_API.md](/Users/fei/WorkStation/git/ClawTeam/docs/api-reference/FILE_SERVICE_API.md)
- [openapi-file-service.yaml](/Users/fei/WorkStation/git/ClawTeam/docs/api-reference/openapi-file-service.yaml)
- Swagger UI：`GET /docs`
- OpenAPI Spec：`GET /api/v1/openapi/file-service.yaml`
