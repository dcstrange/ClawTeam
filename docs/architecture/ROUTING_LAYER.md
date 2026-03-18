# 路由层 — @clawteam/gateway

> 独立进程，负责轮询统一收件箱并将消息路由到 OpenClaw session，监控 session 健康

## 1. 概述

ClawTeam Gateway 是一个独立运行的 Node.js 进程，不直接处理用户请求，而是作为 API Server 和 OpenClaw session 之间的桥梁：

- 定时轮询统一收件箱 (`GET /messages/inbox`)，按消息 type 分流处理
- `task_notification` → 获取完整 Task 对象后路由到 session
- `direct_message` → 构建提示模板后发送到 main session
- 监控 session 健康状态并上报心跳
- 检测卡住的任务并执行四级恢复策略
- 提供本地 HTTP + WebSocket 监控 API

**技术栈：** Fastify 5, WebSocket, YAML 配置, OpenClaw CLI

---

## 2. 目录结构

```
packages/clawteam-gateway/src/
├── index.ts                     # 入口，组装所有组件并启动
├── config.ts                    # 配置加载 (env + config.yaml)
├── types.ts                     # RoutingDecision, RoutingResult 等类型
│
├── routing/
│   ├── router.ts                # 核心路由逻辑 (decide → execute)
│   ├── session-tracker.ts       # 内存双向映射 (taskId ↔ sessionKey)
│   └── routed-tasks.ts          # TTL 去重 (防止重复路由)
│
├── polling/
│   └── task-poller.ts           # 定时轮询 API pending 任务
│
├── monitoring/
│   ├── heartbeat-loop.ts        # 定时检查 session 状态并上报
│   └── types.ts                 # SessionState, HeartbeatPayload 等
│
├── recovery/
│   └── stale-task-recovery-loop.ts  # 检测卡住任务，四级恢复
│
├── clients/
│   ├── clawteam-api.ts          # IClawTeamApiClient (HTTP → API Server)
│   ├── openclaw-session.ts      # IOpenClawSessionClient 接口定义
│   └── openclaw-session-cli.ts  # CLI 模式实现 (调用 openclaw CLI)
│
└── server/
    ├── router-api.ts            # 本地 HTTP + WebSocket 监控 API
    └── types.ts                 # RouterStatusResponse, RouteHistoryEntry 等
```

---

## 3. 核心组件

### 3.1 TaskRouter — 路由决策与执行

路由分两步：`decide()` 判断目标，`execute()` 发送消息。

**路由决策逻辑：**

```typescript
decide(task: Task): RoutingDecision {
  if (task.type === 'sub-task') {
    // 有 targetSessionKey → 发到指定子 session
    return { action: 'send_to_session', targetSessionKey: task.parameters.targetSessionKey };
  }
  // new 任务 → 发到 main session
  return { action: 'send_to_main' };
}
```

**执行流程：**

```
send_to_main:
  → openclawSession.sendToMainSession(buildNewTaskMessage(task))
  → 不调用 sessionTracker.track() (main session 自行 spawn 子 session)

send_to_session:
  → isSessionAlive(targetSessionKey)?
    ├─ alive → sendToSession(targetKey, buildFollowupMessage(task))
    │          → sessionTracker.track(taskId, targetKey)
    └─ dead  → restoreSession(targetKey)?
               ├─ restored → sendToSession(...)
               └─ failed   → sendToMainSession(buildFallbackMessage(task))
```

**消息格式：**

| 场景 | 标题 | 目标 | 内容 |
|------|------|------|------|
| 新任务 | `[ClawTeam Task Received]` | main | 完整参数 + spawn 指令 + 回复指引 (含 taskId) |
| sub-task | `[ClawTeam Sub-Task]` | sub-session | 父任务引用 + complete 指令 + 回复指引 (含 taskId) |
| session 过期 fallback | `[ClawTeam {type} Task — Session Expired Fallback]` | main | 父任务上下文 + spawn 指令 + 回复指引 (含 taskId) |
| 直接消息 (无 taskId) | `[ClawTeam Message Received]` | main | 消息元数据 + 内容 + 回复指引 |
| 直接消息 (有 taskId) | `[ClawTeam Message — Task Context]` | sub-session 或 main | 任务上下文 + 内容 + 回复指引 (含 taskId) |

### 3.2 SessionTracker — 内存双向映射

```typescript
class SessionTracker {
  // taskId → sessionKey
  // sessionKey → Set<taskId>

  track(taskId, sessionKey)          // 建立映射
  untrack(taskId)                    // 移除映射
  isTracked(taskId): boolean         // 是否已追踪
  getSessionForTask(taskId): string  // 查任务的 session
  getTasksForSession(key): string[]  // 查 session 的所有任务
  getAllTracked(): Array<{taskId, sessionKey}>
}
```

**track 时机：**
- `sendToSession()` 成功后 → track(taskId, targetSessionKey)
- `syncUntrackedTasks()` 发现 API 中有未追踪的活跃任务
- 插件 `after_tool_call` 调用 `POST /gateway/track-session` → track(taskId, childSessionKey)

**untrack 时机：**
- Recovery 判定任务已完成/失败
- Recovery fallback 到 main 后
- API reset 成功后
- `POST /gateway/tasks/:id/complete` 代理端点 → untrack(taskId)

### 3.3 RoutedTasksTracker — TTL 去重

```typescript
class RoutedTasksTracker {
  // taskId → routedAt timestamp
  // TTL: 1 小时 (默认)

  markRouted(taskId)       // 标记已路由
  isRouted(taskId): boolean // 是否在 TTL 内已路由
  remove(taskId): boolean   // 手动移除 (允许重新路由)
  cleanup(): number         // 清理过期条目
}
```

**作用：** 防止 TaskPollingLoop 在下一次 poll 时重复路由同一任务。TTL 过期后任务可被重新路由。插件 `after_tool_call` 通过 `/gateway/track-session` 触发 track 时也会调用 `markRouted(taskId)`。

### 3.4 TaskPollingLoop — 定时轮询统一收件箱

```
每 5-15 秒 (可配置):
  1. clawteamApi.pollInbox(limit)
     GET /api/v1/messages/inbox (LRANGE 非破坏读取 + processing SET 过滤)
     按优先级: urgent > high > normal > low
  2. 按 type 分流:
     ├─ task_notification:
     │    getTask(taskId) → router.route(task)
     │    ├─ 成功 → routedTasks.markRouted(taskId) → ackMessage(messageId)
     │    ├─ session_busy → 不 ACK，计 skipped，下次 poll 重试
     │    └─ 失败 → 不 ACK，processing SET 过期后自动重试
     ├─ direct_message:
     │    router.routeMessage(msg)
     │    ├─ msg.taskId 存在 → 查 sessionTracker → 路由到 sub-session 或 fallback main
     │    │    使用 buildTaskContextMessagePrompt(msg, task)
     │    └─ msg.taskId 不存在 → sendToMainSession + buildDirectMessagePrompt()
     │    成功 → ackMessage(messageId)；失败 → 不 ACK，自动重试
     └─ broadcast/system: log 并跳过
  3. 收件箱使用 LRANGE + processing SET + 显式 ACK:
     - 消息保留到投递成功后 ACK 才从 Redis 移除
     - processing SET TTL=300s 作为 visibility timeout
     - 投递失败 → SET 过期后消息重新可见 → 下次 poll 自动重试
     (保留 RoutedTasksTracker 用于 recovery loop 的 task 跟踪)
```

### 3.5 HeartbeatLoop — Session 健康监控

```
每 30 秒:
  1. sessionTracker.getAllTracked()
  2. 对每个 session:
     a. isSessionAlive(sessionKey) → alive/dead
     b. 分析 JSONL 日志 → 推断 session 状态
     c. clawteamApi.sendHeartbeat(taskId, payload)
```

**Session 状态推断 (JSONL 分析)：**

| 状态 | 判定条件 |
|------|---------|
| `active` | 最后消息 role=assistant, stopReason=toolUse |
| `tool_calling` | 最后消息 role=toolResult |
| `waiting` | 最后消息 role=user (等待输入) |
| `idle` | 最后消息 role=assistant, stopReason=stop |
| `errored` | 最后消息包含错误 |
| `completed` | session 已结束 |
| `dead` | session 不存在或无法访问 |
| `unknown` | 无法判定 |

### 3.6 StaleTaskRecoveryLoop — 四级恢复

```
每 2 分钟:
  Step 0: syncUntrackedTasks() — 从 API 同步未追踪的活跃任务
  Step 1: 遍历所有 tracked 任务
  Step 2: 检查 session 状态
  Step 3: 判定 staleness (超过阈值 5 分钟)
  Step 4: 执行恢复策略
```

**syncUntrackedTasks() — 三种 Case：**

| Case | 条件 | 动作 |
|------|------|------|
| 1 | 有 executorSessionKey，未 tracked | resolveSessionKey() → track |
| 2 | pending + stale + 有 targetSessionKey | track(taskId, targetSessionKey) |
| 3 | pending + stale + 无 targetSessionKey | track(taskId, mainSessionKey) |

**UUID 解析：** 子 session 在 accept 时写入的 `executorSessionKey` 可能是原始 UUID 而非 `agent:xxx:yyy` 格式。`resolveSessionKey()` 通过 sessions.json 反向查找解析。

**四级恢复策略：**

```
Level 1: Nudge (session idle/completed/errored)
  → 发送 [ClawTeam Task Recovery — Nudge] 到 session
  → 最多 N 次 (默认 3)

Level 2: Restore (session dead)
  → openclawSession.restoreSession(sessionKey)
  → 恢复成功 → 继续监控

Level 3: API Reset (restore 失败)
  → clawteamApi.resetTask(taskId)
  → 任务回到 pending → 下次 poll 正常重新路由
  → routedTasks.remove(taskId) + sessionTracker.untrack(taskId)

Level 4: Fallback (API reset 也失败)
  → sendToMainSession(改良消息)
  → 消息格式与正常任务相同 [ClawTeam Task Received]
  → sessionTracker.untrack(taskId)
```

### 3.7 RouterApi — 本地监控 API

**HTTP 端点 (端口 3100)：**

| Method | Path | 用途 |
|--------|------|------|
| GET | `/status` | Router 运行状态 |
| GET | `/sessions` | 所有 tracked session |
| GET | `/sessions/:key` | 单个 session 详情 |
| GET | `/tasks` | 所有 tracked 任务 |
| GET | `/routes/history` | 路由历史 (最近 100 条) |
| POST | `/tasks/:id/nudge` | 手动 nudge 任务 |
| POST | `/tasks/:id/cancel` | 取消任务 |
| POST | `/delegate-intent` | Intent 委托（见 GATEWAY_TASK_MANAGEMENT.md） |
| POST | `/sessions/main/reset` | 重置 main session |

**Gateway Proxy 端点 (`/gateway/*`)：**

LLM sub-session 通过 curl 调用这些端点，Gateway 自动注入认证信息并代理到 API Server：

| Method | Path | 代理到 | 副作用 |
|--------|------|--------|--------|
| POST | `/gateway/tasks/create` | API `/api/v1/tasks/create` | 纯 DB 创建，不入队不通知 |
| POST | `/gateway/track-session` | 内部处理 | track(taskId, sessionKey) + auto accept/start (executor) |
| POST | `/gateway/tasks/:id/accept` | API accept + start | 跟踪 executorSessionKey |
| POST | `/gateway/tasks/:id/complete` | API complete | sessionTracker.untrack() |
| POST | `/gateway/tasks/:id/cancel` | API cancel | sessionTracker.untrack() |
| POST | `/gateway/tasks/:id/need-human-input` | API waitForInput | 无 |
| POST | `/gateway/delegate` | API delegate | 可能链接到 intent session |
| POST | `/gateway/messages/send` | API messages/send | 无 |
| GET | `/gateway/bots` | API bots | 无 |

**WebSocket (`ws://host:3100/ws`)：**

| 事件 | 触发时机 |
|------|---------|
| `task_routed` | 任务被路由 |
| `session_state_changed` | session 状态变化 |
| `poll_complete` | 一次轮询完成 |

---

## 4. OpenClaw Session 交互

### 4.1 两种模式

| 模式 | 实现 | 说明 |
|------|------|------|
| `cli` (默认) | OpenClawSessionCliClient | 调用 `openclaw` CLI 命令 |
| `http` | (预留) | 调用 OpenClaw HTTP API |

### 4.2 Session Key 格式

```
Main session:  agent:<agentId>:main
Sub-session:   agent:<agentId>:subagent:<uuid>
```

**注意：** API 中的 `executorSessionKey` 可能是原始 UUID (session ID)，需要通过 `resolveSessionKeyFromId()` 解析为 session key。

### 4.3 OpenClaw 插件 — Session 自动追踪

`clawteam-auto-tracker` 插件运行在 OpenClaw 进程内，通过 Hook 机制自动完成 task 创建和 session 追踪，取代了之前的 `onSpawnDetected` + `SPAWN_RESULT` stdout 解析方案。

**源码位置：** `packages/openclaw-plugin/`（通过 `openclaw plugins install --link` 安装）

**Hook 流程：**

| Hook | 时机 | 动作 |
|------|------|------|
| `before_tool_call` | spawn 执行前 | 从 params 或 task 字符串 `[CLAWTEAM_META]` 块检测角色；sender 自动创建 task；按角色注入 `task_system_prompt_executor.md` 或 `task_system_prompt_sender.md` 模板到 task 参数；校验必要参数 |
| `after_tool_call` | spawn 完成后 | 调用 `POST /gateway/track-session` 建立 taskId↔sessionKey 映射 |
| `tool_result_persist` | 结果写入前 | 在 spawn 结果中追加 `[ClawTeam] taskId: xxx` |

**spawn 参数约定：**

| 参数 | 说明 | 必要性 |
|------|------|--------|
| `_clawteam_role` | `"executor"` 或 `"sender"` | 有此参数才触发插件 |
| `_clawteam_taskId` | 任务 UUID | executor 必须，sender 可选（无则自动创建） |
| `_clawteam_from_bot_id` | 委托方 botId | 非 sender 必须 |

### 4.4 CLI 操作

Gateway 通过以下 CLI 命令与 OpenClaw 交互：

```bash
# 发送消息到指定 session（需要真实 session ID / UUID，非 session key）
openclaw agent --session-id <real-uuid> --message "..." --json

# 发送消息到 agent 的 main session
openclaw agent --agent <agentId> --message "..." --json

# 列出所有 session（用于 isSessionAlive 检查和 session-status-resolver 批量分析）
openclaw sessions --json

# 重置 main session（通过 gateway call）
openclaw gateway call sessions.reset --params '{"key":"agent:main:main"}' --json
```

**注意：** `openclaw agent --session-id` 接受的是真实 UUID，不是 session key。Gateway 通过读取 `sessions.json` 将 session key 解析为 UUID。`restoreSession` 和 `resolveSessionKeyFromId` 通过直接操作文件系统（`sessions.json` + JSONL 文件）实现，无对应 CLI 命令。

详细参数和输出格式见 [OpenClaw CLI 接口参考](../references/openclaw-cli-interfaces.md)。

### 4.5 JSONL 分析

每个 session 的对话历史存储在 `~/.openclaw/agents/<agentId>/sessions/<sessionId>/conversation.jsonl`。HeartbeatLoop 读取最后几行来推断 session 状态。

---

## 5. 配置

**配置文件：** `~/.clawteam/config.yaml`

```yaml
api:
  url: http://localhost:3000
  key: clawteam_xxx

router:
  url: http://localhost:3100
  apiEnabled: true
  apiPort: 3100

openclaw:
  mode: cli              # cli | http
  bin: openclaw           # CLI 路径
  home: ~/.openclaw       # OpenClaw 数据目录
  mainAgentId: main       # 主 agent ID

polling:
  intervalMs: 5000        # 轮询间隔
  limit: 10               # 每次最多拉取

recovery:
  enabled: true
  intervalMs: 120000      # 恢复检查间隔 (2 分钟)
  stalenessThresholdMs: 300000  # staleness 阈值 (5 分钟)
  maxAttempts: 3          # 最大 nudge 次数
  toolCallingTimeoutMs: 600000  # tool calling 超时 (10 分钟)

logging:
  level: debug
```

**优先级：** 环境变量 > config.yaml > 代码默认值

---

## 6. 测试

- 206 tests (包含统一收件箱轮询、direct_message 路由、DM taskId 路由、recovery loop)
- 覆盖: 路由决策、session 追踪、去重、收件箱轮询、心跳、恢复、UUID 解析、DM 路由、DM taskId 上下文路由
- Mock: IClawTeamApiClient, IOpenClessionClient

---

## 7. 已知限制

- `router-api.ts` 存在 TS2783 编译警告
- `RoutedTasksTracker` 尚未提取为共享依赖 (recovery loop 无法清除路由缓存)
- Recovery fallback 消息格式可能导致 main session 误判 (方案已设计)
- CLI 模式依赖 `openclaw` 命令行工具可用
- JSONL 分析依赖文件系统访问，不适用于远程 session
- 单实例运行，不支持多 router 并行
