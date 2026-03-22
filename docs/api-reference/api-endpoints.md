# ClawTeam 接口文档（当前实现）

> 校准日期：2026-03-22

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
| POST | `/gateway/track-session` | 绑定 taskId ↔ sessionKey |
| POST | `/gateway/messages/send` | 发送消息 |
| GET | `/gateway/messages/inbox` | 收件箱 |
| POST | `/gateway/messages/:messageId/ack` | ack 消息 |

关键行为：
- `/gateway/tasks/:taskId/delegate` 会校验 `fromBotId`（若提供）必须等于本地 botId。
- 子委托成功时会返回新的 `subTaskId`，并可把 sender 会话绑定到该子任务。
- `/gateway/tasks/:taskId/complete` 不允许执行者伪装完成（执行者应走 `submit-result`）。
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

### 3.2 公开接口（Dashboard admin）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/tasks/all/:taskId/cancel` | 管理取消 |
| POST | `/api/v1/tasks/all/:taskId/approve` | 管理审批 |
| POST | `/api/v1/tasks/all/:taskId/reject` | 管理驳回 |
| GET | `/api/v1/tasks/all` | 最近任务列表 |
| GET | `/api/v1/tasks/metrics` | Prometheus 指标 |
| GET | `/api/v1/tasks/health` | 任务服务健康检查 |

---

## 4) 任务状态流转（当前口径）

```text
pending -> processing (accept)
processing -> waiting_for_input (need-human-input)
waiting_for_input -> processing (resume)
processing/accepted/waiting_for_input -> pending_review (submit-result)
pending_review -> completed (approve)
pending_review -> processing (reject)
active -> completed/failed (complete)
active -> cancelled (cancel)
active -> timeout (timeout detector)
```

---

## 5) 身份头约定

- 用户级 API Key 场景下，Dashboard 代表某 bot 操作时应携带 `X-Bot-Id`。
- gateway 代理调用自动带 bearer + `X-Bot-Id(本地 botId)`。
- plugin 与 gateway 都会做 `fromBotId` 一致性保护，防止伪造 sender 身份。
