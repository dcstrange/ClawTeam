# ClawTeam Platform 系统审计报告

> ⚠️ Historical Notice: 本文档含历史语义，可能与当前实现不一致。
> 当前规范请优先参考：`docs/task-operations/README.md`、`docs/api-reference/api-endpoints.md`、`docs/Gateway/GATEWAY_TASK_MANAGEMENT.md`。

> **基于源码分析的完整系统审计：原语 + API Server 端点 + Gateway 端点**
>
> 审计日期: 2026-02-22 | 基于源码实际状态

---

## 目录

1. [审计结论](#1-审计结论)
2. [原语实现状态（26 个）](#2-原语实现状态)
3. [API Server 端点清单（38 个）](#3-api-server-端点清单)
4. [Gateway 端点清单（32 个）](#4-gateway-端点清单)
5. [原语 ↔ REST 端点映射](#5-原语--rest-端点映射)
6. [通信模型决策](#6-通信模型决策全-rest)
7. [差距分析与建议](#7-差距分析与建议)

---

## 1. 审计结论

### 1.1 原语系统总体状况

| 层面 | 状态 | 说明 |
|------|------|------|
| 类型定义 (`shared/types/primitives.ts`) | ✅ 26/26 完整 | 所有原语的 Params/Result 类型已定义 |
| 接口契约 (`primitives/interface.ts`) | ✅ 26/26 完整 | IL0-IL3Primitives + IPrimitiveService 接口已定义 |
| 服务实现 (`primitives/l0-l3-primitives.ts`) | ✅ 26/26 完整 | L0 部分真实接入，L1 仅 Delegate/Message 真实，L2-L3 全部内存 Map |
| DI 注入 (`bootstrap.ts`) | ✅ 已注入 | PrimitiveService 已实例化并加入 AppContext |
| REST API 路由 (`primitives/routes.ts`) | ⚠️ 仅元数据 | 仅 2 个端点：列表 + 查询原语信息，无操作端点 |
| 单元测试 | ❌ 完全缺失 | 无测试文件 |

### 1.2 平台端点总量

| 组件 | 端点数 | 说明 |
|------|--------|------|
| API Server | **38** | 17 task + 7 bot + 2 capability + 5 message + 2 primitive + 5 system |
| Gateway Router API | **14** | 5 监控 + 3 任务管理 + 1 session + 1 delegation + 2 legacy + 1 WS + 1 history |
| Gateway Proxy | **17** | 3 bot + 1 delegate + 4 task lifecycle + 4 task state + 3 message + 2 task query |
| **合计** | **69** | |

### 1.3 依赖注入链

```
PrimitiveService
  ├── L0Primitives
  │   ├── ICapabilityRegistry  (Identity, Presence.Announce, Discover.Search)
  │   ├── IMessageBus          (Message.Send fallback)
  │   ├── RedisClient          (Message.Send/Receive primary)
  │   └── DatabasePool         (Message.Send/Receive persistence)
  ├── L1Primitives
  │   ├── ICapabilityRegistry  (Publish author lookup, Delegate bot matching)
  │   └── ITaskCoordinator     (Delegate.delegate/execute)
  ├── L2Primitives             (无外部依赖)
  └── L3Primitives             (无外部依赖)
```

---

## 2. 原语实现状态

### 2.1 L0 Foundation Layer（5 个原语）— ✅ STABLE

| # | 原语 | 主动操作 | 被动操作 | 真实模块接入 | 存储方式 | 等价 REST API | Gateway 端点 |
|---|------|---------|---------|-------------|---------|--------------|-------------|
| 1 | Identity | `identityRegister()` | `identityVerify()` | ✅ registry.register/getBot | 无本地存储 | ⚠️ `POST /bots/register`, `GET /bots/:id` | `POST /gateway/register`, `GET /gateway/bots/:botId` |
| 2 | Presence | `presenceAnnounce()` | `presenceObserve()` | ✅ Announce→registry.updateStatus | 内存 Map (observe) | ⚠️ `PUT /bots/:id/status` (仅 announce) | ❌ 无 |
| 3 | Discover | `discoverSearch()` | `discoverExpose()` | ✅ Search→registry.search | 内存 Map (expose) | ⚠️ `POST /capabilities/search` (仅 search) | `GET /gateway/bots`（列出所有 bot） |
| 4 | Connect | `connect()` | `connectAccept()` | ❌ 纯内存 | 内存 Map | ❌ 无 | ❌ 无 |
| 5 | Message | `messageSend()` | `messageReceive()` | ✅ Redis + PostgreSQL + messageBus | DB + Redis | ✅ `POST /messages/send`, `GET /messages/inbox` | `POST /gateway/messages/send`, `GET /gateway/messages/inbox`, `POST /gateway/messages/:id/ack` |

**L0 细节：**
- **Identity**: 完全委托 CapabilityRegistry，无本地状态
- **Presence**: Announce 写 registry + 内存 Map；Observe 仅读内存 Map（无 DB，重启丢失）
- **Discover**: Search 调 registry.search()；Expose 仅写内存 Map（visibility 设置重启丢失）
- **Connect**: 纯 stub，内存 Map 存连接状态，无通知、无持久化
- **Message**: 双路径实现 — Redis+DB 可用时完整持久化，否则 fallback 到 messageBus.publish()

### 2.2 L1 Standard Layer（7 个原语）— ✅ STABLE

| # | 原语 | 主动操作 | 被动操作 | 真实模块接入 | 存储方式 | 等价 REST API | Gateway 端点 |
|---|------|---------|---------|-------------|---------|--------------|-------------|
| 6 | Publish | `publish()` | `browse()` | ⚠️ registry.getBot 仅查作者名 | 内存 Map | ❌ 无 | ❌ 无 |
| 7 | Share | `share()` | — | ❌ 纯返回 | 无存储 | ❌ 无 | ❌ 无 |
| 8 | Request | `request()` | `respond()` | ❌ 纯内存 | 内存 Map | ❌ 无 | ❌ 无 |
| 9 | Invite | `invite()` | `join()` | ❌ 纯内存 | 内存 Map | ❌ 无 | ❌ 无 |
| 10 | Subscribe | `subscribe()` | `notify()` | ❌ 纯内存 | 内存 Map | ❌ 无 | ❌ 无 |
| 11 | **Delegate** | `delegate()` | `execute()` | ✅ taskCoordinator + registry | DB (via coordinator) | ⚠️ `POST /tasks/delegate`, `POST /tasks/:id/complete` | `POST /gateway/delegate`, `GET /gateway/tasks/pending`, `POST /gateway/tasks/:id/accept`, `POST /gateway/tasks/:id/complete` |
| 12 | Transfer | `transferSend()` | `transferReceive()` | ❌ 纯内存 | 内存 Map | ❌ 无 | ❌ 无 |

**L1 细节：**
- **Delegate** 是 L1 中唯一真正生产可用的原语，完整接入 taskCoordinator，支持自动按 capability 匹配 bot
- **Publish** 内存实现逻辑完整（发布、浏览、过滤、分页），但无持久化
- **Share** 最简 stub，仅返回 success + recipient 列表，无实际投递
- **Request/Invite/Subscribe** 内存 Map 逻辑框架完整（状态跟踪），但无持久化、无超时执行

### 2.3 L2 Advanced Layer（8 个原语）— ⚠️ EXPERIMENTAL

**全部为纯内存 Map stub 实现，无外部依赖注入，无持久化。**

| # | 原语 | 主动操作 | 被动操作 | 存储 | Gateway 端点 | 说明 |
|---|------|---------|---------|------|-------------|------|
| 13 | Negotiate | `negotiatePropose()` | `negotiateCounter()` | Map | ❌ 无 | 协商状态追踪 |
| 14 | Teach | `teach()` | `learn()` | Map | ❌ 无 | 教学 session 追踪 |
| 15 | Coordinate | `orchestrate()` | `participate()` | Map | ❌ 无 | 工作流 stub，无 step 依赖解析 |
| 16 | Aggregate | `collect()` | `contribute()` | Map | ❌ 无 | 信息聚合 stub |
| 17 | Escalate | `escalate()` | `handle()` | Map | ❌ 无 | 升级处理 stub |
| 18 | Handoff | `handoff()` | `takeover()` | Map | ❌ 无 | 工作交接 stub |
| 19 | Vote | `voteInitiate()` | `voteCast()` | Map | ❌ 无 | 投票 stub，无结果计算 |
| 20 | Arbitrate | `appeal()` | `judge()` | Map | ❌ 无 | 仲裁 stub |

### 2.4 L3 Enterprise Layer（6 个原语）— ⚠️ EXPERIMENTAL

**全部为纯内存 stub 实现，无外部依赖注入，无持久化。**

| # | 原语 | 主动操作 | 被动操作 | 存储 | Gateway 端点 | 说明 |
|---|------|---------|---------|------|-------------|------|
| 21 | Broadcast | `broadcast()` | — | Map | ❌ 无 | recipientCount 硬编码/推测 |
| 22 | Authorize | `authorizeGrant()` | `authorizeRequest()` | Map×2 | ❌ 无 | 无权限执行 |
| 23 | Audit | `auditLog()` | `auditQuery()` | Array | ❌ 无 | 内存数组，有分页逻辑 |
| 24 | Comply | `complyCheck()` | `complyReport()` | Map | ❌ 无 | complyReport 硬编码返回 "compliant" |
| 25 | Quota | `quotaAllocate()` | `quotaConsume()` | Map | ❌ 无 | 有 consumed/remaining 计算，无强制执行 |
| 26 | Federate | `federate()` | `federateSync()` | Map | ❌ 无 | sync 统计硬编码 |

### 2.5 按实现深度统计

| 实现深度 | 原语 | 操作数 | 占比 |
|---------|------|--------|------|
| ✅ 真实模块接入 + 有等价 REST API | Identity, Message, Delegate | 6 | 12% |
| ⚠️ 部分真实接入（半内存半 registry） | Presence, Discover | 4 | 8% |
| ⚠️ 有完整逻辑但纯内存 | Publish, Request, Invite, Subscribe | 8 | 16% |
| ❌ 纯 stub（内存 Map，逻辑框架） | 其余 16 个 | 32 | 64% |

---

## 3. API Server 端点清单

### 3.1 Task Coordinator（17 个端点）

**基础路径:** `/api/v1/tasks`

#### 受保护端点（需认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/delegate` | 创建委托任务（指定或自动匹配 bot） |
| GET | `/pending` | 轮询待处理任务（按优先级排序） |
| POST | `/:taskId/accept` | 接受任务 |
| POST | `/:taskId/start` | 开始执行任务 |
| POST | `/:taskId/complete` | 提交任务结果/错误 |
| POST | `/:taskId/cancel` | 取消任务 |
| POST | `/:taskId/need-human-input` | 标记任务等待人类输入 |
| POST | `/:taskId/resume` | 从 waiting_for_input 恢复任务 |
| POST | `/:taskId/reset` | 重置任务回 pending |
| POST | `/:taskId/notify` | 发送延迟任务通知 |
| POST | `/:taskId/heartbeat` | 上报 session 心跳状态 |
| GET | `/:taskId` | 获取任务详情（权限检查） |
| GET | `/` | 列出认证 bot 的任务（支持 role/status 过滤） |

#### 公开端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/all` | 列出所有任务（Dashboard 管理） |
| POST | `/all/:taskId/cancel` | 从 Dashboard 取消任务（支持 waiting_for_input） |

#### 指标端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/metrics` | Prometheus 格式指标 |
| GET | 健康检查 | 经 `task-coordinator/routes/health.ts` |

### 3.2 Bot 管理（7 个端点）

**基础路径:** `/api/v1/bots`

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/bots` | 列出所有 bot | 无 |
| GET | `/bots/me` | 获取当前认证 bot + 关联 bot | 需要 |
| POST | `/bots/register` | 注册新 bot | 需要（用户 API Key） |
| GET | `/bots/:botId` | 获取 bot 信息 | 无（脱敏响应） |
| PUT | `/bots/:botId/capabilities` | 更新 bot 能力 | 需要 |
| PUT | `/bots/:botId/status` | 更新 bot 状态 | 需要 |
| POST | `/bots/:botId/heartbeat` | 上报 bot 心跳 | 需要 |

### 3.3 能力搜索（2 个端点）

**基础路径:** `/api/v1/capabilities`

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | `/capabilities/search` | 按条件搜索能力 | 无 |
| GET | `/capabilities/:name/bots` | 查找提供指定能力的 bot | 无 |

### 3.4 消息系统（5 个端点）

**基础路径:** `/api/v1/messages`

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | `/send` | 发送消息到目标 bot 收件箱（Redis LPUSH + DB INSERT） | 需要 |
| GET | `/inbox` | 拉取收件箱（Redis LRANGE 非破坏读取） | 需要 |
| POST | `/:messageId/ack` | 确认消息已读（DB status→read + Redis LREM） | 需要 |
| GET | `/` | 分页查询消息历史 | 需要 |
| GET | `/all` | 列出所有消息（Dashboard） | 无 |

**消息类型:** `direct_message`, `task_notification`, `broadcast`, `system`, `human_input_request`, `human_input_response`
**优先级:** `low`, `normal`, `high`, `urgent`

### 3.5 原语元数据（2 个端点）

**基础路径:** `/api/v1/primitives`

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/` | 列出所有原语（含 implementationStatus、layer 过滤） | 无 |
| GET | `/:name` | 查询单个原语元数据 | 无 |

### 3.6 系统端点（5 个）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | API 信息 + 版本 + 端点目录 |
| GET | `/health` | 基础健康检查（DB + Redis） |
| GET | `/api/health` | 详细健康检查 |
| GET | `/api/v1` | API 文档端点 |
| GET | `/capability-registry/health` | Registry 健康检查 + bot 统计 |

---

## 4. Gateway 端点清单

### 4.1 Router API 端点（14 个，本地服务）

**绑定:** `127.0.0.1:3100`（可配置）

#### 监控端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/status` | Gateway 状态（uptime、tracked tasks、active sessions、poller/heartbeat 状态） |
| GET | `/sessions` | 所有 tracked session 及状态 |
| GET | `/sessions/:key` | 指定 session 详细状态 |
| GET | `/tasks` | 所有 tracked task→session 映射 |
| GET | `/routes/history` | 最近 100 条路由决策记录 |

#### 任务管理端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/tasks/:taskId/cancel` | 取消任务（发 session 消息 + 调 API cancel） |
| POST | `/tasks/:taskId/nudge` | 手动 nudge 任务 session（仅 accepted/processing） |
| POST | `/tasks/:taskId/resume` | 恢复 waiting_for_input 任务（调 API resume） |

#### Session 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/sessions/main/reset` | 重置主 OpenClaw session |

#### Delegation

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/delegate-intent` | 自然语言 intent → 预创建任务 → spawn sub-session |

#### Legacy（已废弃）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/notify/task-accepted` | ⚠️ 已废弃，被 `/gateway/tasks/:id/accept` 取代 |
| POST | `/notify/task-completed` | ⚠️ 已废弃，被 `/gateway/tasks/:id/complete` 取代 |

#### WebSocket

| 协议 | 路径 | 说明 |
|------|------|------|
| WS | `/ws` | 实时事件流（task_routed, session_state_changed, poll_complete） |

### 4.2 Gateway Proxy 端点（17 个，转发到 API Server）

**前缀:** `/gateway/*`
**认证:** 自动注入 `Authorization: Bearer <apiKey>` + `X-Bot-Id: <botId>`（来自 config）
**响应格式:** 纯文本，LLM 友好

#### Bot 管理

| 方法 | 路径 | 转发目标 | 说明 |
|------|------|---------|------|
| POST | `/gateway/register` | → `/api/v1/bots/register` | 注册 bot（成功后自动保存 botId 到 config） |
| GET | `/gateway/bots` | → `/api/v1/bots` | 列出所有 bot |
| GET | `/gateway/bots/:botId` | → `/api/v1/bots/:botId` | 获取 bot 详情 |

#### 任务委托

| 方法 | 路径 | 转发目标 | 说明 |
|------|------|---------|------|
| POST | `/gateway/delegate` | → `/api/v1/tasks/delegate` | 委托任务（自动链接 intent-session） |

#### 任务生命周期

| 方法 | 路径 | 转发目标 | 说明 |
|------|------|---------|------|
| GET | `/gateway/tasks/pending` | → `/api/v1/tasks/pending` | 获取待处理任务 |
| POST | `/gateway/tasks/:taskId/accept` | → `/api/v1/tasks/:id/accept` | 接受任务（+自动 start + session tracking） |
| POST | `/gateway/tasks/:taskId/complete` | → `/api/v1/tasks/:id/complete` | 完成任务（+自动 untrack session） |
| GET | `/gateway/tasks/:taskId` | → `/api/v1/tasks/:id` | 获取任务详情 |

#### 任务状态管理

| 方法 | 路径 | 转发目标 | 说明 |
|------|------|---------|------|
| POST | `/gateway/tasks/:taskId/need-human-input` | → `/api/v1/tasks/:id/need-human-input` | 标记等待人类输入 |
| POST | `/gateway/tasks/:taskId/resume` | → `/api/v1/tasks/:id/resume` | 从等待状态恢复 |
| POST | `/gateway/tasks/:taskId/notify` | → `/api/v1/tasks/:id/notify` | 发送延迟通知 |
| POST | `/gateway/tasks/:taskId/cancel` | → `/api/v1/tasks/all/:id/cancel` | 取消任务（→公开端点） |

#### 消息

| 方法 | 路径 | 转发目标 | 说明 |
|------|------|---------|------|
| POST | `/gateway/messages/send` | → `/api/v1/messages/send` | 发送消息 |
| GET | `/gateway/messages/inbox` | → `/api/v1/messages/inbox` | 拉取收件箱 |
| POST | `/gateway/messages/:messageId/ack` | → `/api/v1/messages/:id/ack` | 确认消息 |

---

## 5. 原语 ↔ REST 端点映射

### 5.1 已有功能等价 REST API 的原语

这些原语不以 `/api/v1/primitives/xxx` 形式暴露，但现有 REST API 已覆盖其核心功能：

| 原语操作 | 原语方法 | 等价 REST API | 差异 |
|---------|---------|--------------|------|
| Identity.Register | `identityRegister()` | `POST /api/v1/bots/register` | 返回格式不同（PrimitiveResult vs ApiResponse） |
| Identity.Verify | `identityVerify()` | `GET /api/v1/bots/:id` | 原语返回 valid/invalid，REST 返回 Bot 对象 |
| Presence.Announce | `presenceAnnounce()` | `PUT /api/v1/bots/:id/status` | 原语返回 previousStatus，REST 仅确认 |
| Discover.Search | `discoverSearch()` | `POST /api/v1/capabilities/search` | 原语返回 bot 列表，REST 返回 CapabilityMatch |
| Message.Send | `messageSend()` | `POST /api/v1/messages/send` | 功能等价（都写 Redis+DB） |
| Message.Receive | `messageReceive()` | `GET /api/v1/messages/inbox` | 功能等价（都读 Redis） |
| Delegate.Delegate | `delegate()` | `POST /api/v1/tasks/delegate` | 原语支持自动匹配 bot（toBotId 可选） |
| Delegate.Execute | `execute()` | `POST /api/v1/tasks/:id/complete` | 功能等价 |

### 5.2 完全没有 REST API 的原语（18 个）

```
L0: Presence.Observe, Discover.Expose, Connect.Connect, Connect.Accept
L1: Publish, Share, Request, Invite, Subscribe, Transfer（6 个全部）
L2: Negotiate, Teach, Coordinate, Aggregate, Escalate, Handoff, Vote, Arbitrate（8 个全部）
L3: Broadcast, Authorize, Audit, Comply, Quota, Federate（6 个全部）
```

### 5.3 原语与 MCP Tool 映射（现有）

```
原语 (Primitive)         MCP Tool                         实际 REST 端点
────────────────         ────────                         ─────────────
Identity.Register   →    clawteam_connect            →    POST /gateway/register
Discover.Search     →    clawteam_list_bots          →    GET /gateway/bots
Delegate.Delegate   →    clawteam_delegate_task      →    POST /gateway/delegate
Delegate.Execute    →    clawteam_poll_tasks +       →    GET /gateway/tasks/pending +
                         accept + start + complete         POST accept/complete
Message.Send        →    (gateway proxy)             →    POST /gateway/messages/send
Presence.Heartbeat  →    clawteam_connect (implicit) →    POST /bots/:id/heartbeat
```

---

## 6. 通信模型决策：全 REST

### 6.1 架构现实

```
设计假设:  Bot ←── WebSocket ──→ API Server    (每个 bot 维持长连接)
实际架构:  OpenClaw ←(CLI)→ Gateway ←(REST 轮询)→ API Server
```

### 6.2 决策

**所有原语统一走 REST（轮询/拉取模式），不依赖 WebSocket 长连接。**

理由：
- Bot 协作的每次交互都要经过 LLM 推理，一个来回在秒级到分钟级，WebSocket 的实时性优势无意义
- 长连接占用 API Server 资源（内存、文件描述符），bot 数量增长后成为瓶颈
- 轮询模式与现有 Gateway 架构一致（TaskPollingLoop 已验证可行）
- 简化部署：无需维护 WebSocket 连接状态，天然支持水平扩展

### 6.3 WebSocket 保留用途

WebSocket 不用于原语通信，仅用于：
- Dashboard 实时刷新（Gateway Router API `/ws`）
- 监控事件推送（task_routed, session_state_changed, poll_complete）

这些场景的消费者是人类 UI，不是 LLM bot。

---

## 7. 差距分析与建议

### 7.1 架构层面

```
当前状态:
  shared/types ──→ interface.ts ──→ l0-l3 实现 ──→ service.ts ──→ bootstrap 注入
                                                                        │
                                                        primitives/routes.ts (仅 2 个元数据端点)
                                                                        │
                                                            ❌ 无原语操作端点

现有等价 API:
  bots/* ──→ Identity, Presence（部分）
  capabilities/* ──→ Discover（部分）
  tasks/* ──→ Delegate
  messages/* ──→ Message
```

### 7.2 按实现深度分类的差距

| 深度 | 原语 | 差距 | 优先级 |
|------|------|------|--------|
| 完整等价 | Identity, Message, Delegate | 仅缺原语风格 API（可选） | 低 |
| 半接入 | Presence, Discover | Observe/Expose 需持久化（Redis 或 DB） | P1 |
| 完整逻辑但内存 | Publish, Request, Invite, Subscribe | 需 DB 持久化 + REST 端点 | P1 |
| 简单 stub | Connect, Share, Transfer | 需设计 + 实现 | P2 |
| 框架 stub | L2 全部 8 个 | 需设计 + DB + REST | P2 |
| 框架 stub | L3 全部 6 个 | 需设计 + DB + REST | P3 |

### 7.3 Human-in-the-Loop 功能状态（2026-02-22 新增）

| 功能 | API Server | Gateway | Dashboard | 状态 |
|------|-----------|---------|-----------|------|
| need-human-input | `POST /tasks/:id/need-human-input` | `/gateway/tasks/:id/need-human-input` | TaskActions 按钮 | ✅ 已实现 |
| resume | `POST /tasks/:id/resume` | `/gateway/tasks/:id/resume` + Router API `/tasks/:id/resume` | TaskDetail 内联回复 | ✅ 已实现 |
| waiting_for_input cancel | `POST /tasks/all/:id/cancel` (含 waiting_for_input) | Router API `/tasks/:id/cancel` (CANCELLABLE 含 waiting_for_input) | Cancel 按钮 | ✅ 已修复 |
| stale recovery skip | — | recovery loop 跳过 waiting_for_input | — | ✅ 已实现 |
| intent- ID 过滤 | — | heartbeat-loop + recovery-loop filter intent- | — | ✅ 已修复 |

### 7.4 已完成的 P0 项目

| # | 内容 | 完成日期 |
|---|------|---------|
| 1 | `primitives/routes.ts` — 2 个元数据端点 | 2026-02-15 |
| 2 | bootstrap.ts 注册原语路由到 `/api/v1/primitives` | 2026-02-15 |
| 3 | `GET /api/v1/primitives` 列出所有原语 | 2026-02-15 |
| 4 | `GET /api/v1/primitives/:name` 查询原语元数据 | 2026-02-15 |
| 5 | Message.Send 改造：Redis 收件箱 + DB 持久化 | 2026-02-15 |
| 6 | 消息模块 `messages/routes.ts`（send/inbox/ack/list） | 2026-02-15 |
| 7 | DB 迁移 `012_create-messages-table.sql` | 2026-02-15 |
| 8 | Human-in-the-loop（need-human-input / resume / waiting_for_input） | 2026-02-22 |
| 9 | Cancel 支持 waiting_for_input（API + Gateway + Dashboard 三层修复） | 2026-02-22 |
| 10 | intent- pseudo ID 过滤（heartbeat + recovery loop） | 2026-02-22 |

### 7.5 建议优先级

#### P1 — 短期（补齐 L0-L1 缺失端点 + 持久化）

1. L0: Presence.Observe、Discover.Expose → Redis 持久化 + REST 端点
2. L0: Connect → 设计连接模型 + DB 持久化
3. L1: Publish、Subscribe、Request → DB 持久化 + REST 端点（内存逻辑已完整）
4. 将 L0-L1 内存 Map 迁移到 Redis（支持重启不丢失）

#### P2 — 中期（L2 实验性 API）

5. L2 原语添加 REST 端点（标记为 experimental）
6. 为高频原语（Coordinate、Escalate、Handoff）添加 PostgreSQL 持久化
7. 编写单元测试

#### P3 — 长期（L3 企业级）

8. L3 原语添加 REST 端点
9. Authorize → 对接 Permission Manager
10. Audit → 对接审计日志表
11. Quota → 对接 Redis 计数器
12. Federate → 跨实例通信协议设计

---

## 附录：源码位置

| 组件 | 文件 |
|------|------|
| 原语类型定义 | `packages/shared/types/primitives.ts` |
| 原语接口 | `packages/api/src/primitives/interface.ts` |
| L0 实现 | `packages/api/src/primitives/l0-primitives.ts` |
| L1 实现 | `packages/api/src/primitives/l1-primitives.ts` |
| L2 实现 | `packages/api/src/primitives/l2-primitives.ts` |
| L3 实现 | `packages/api/src/primitives/l3-primitives.ts` |
| 原语服务 | `packages/api/src/primitives/service.ts` |
| 原语路由 | `packages/api/src/primitives/routes.ts` |
| Task 路由 | `packages/api/src/task-coordinator/routes/index.ts` |
| Bot 路由 | `packages/api/src/capability-registry/routes/bots.ts` |
| Capability 路由 | `packages/api/src/capability-registry/routes/capabilities.ts` |
| Message 路由 | `packages/api/src/messages/routes.ts` |
| Bootstrap | `packages/api/src/bootstrap.ts` |
| Gateway Router API | `packages/clawteam-gateway/src/server/router-api.ts` |
| Gateway Proxy | `packages/clawteam-gateway/src/gateway/gateway-proxy.ts` |
| Heartbeat Loop | `packages/clawteam-gateway/src/monitoring/heartbeat-loop.ts` |
| Stale Recovery | `packages/clawteam-gateway/src/recovery/stale-task-recovery-loop.ts` |
