# Gateway 任务状态管理

> 本文档描述 ClawTeam Gateway 对任务生命周期的完整管理机制。各组件的详细文档见同目录下的独立文件。

## 架构总览

Gateway 是运行在开发者本地的代理服务，介于远程 API Server 和本地 OpenClaw Agent Session 之间。它通过多个协作的循环（loop）管理任务的完整生命周期。

```
┌─────────────────────── Gateway 进程 ──────────────────────┐
│                                                            │
│  ┌──────────────┐   ┌──────────────┐   ┌───────────────┐  │
│  │ TaskPoller   │   │ HeartbeatLoop│   │ RecoveryLoop  │  │
│  │ (5s 间隔)    │   │ (30s 间隔)   │   │ (30s 间隔)    │  │
│  └──────┬───────┘   └──────┬───────┘   └──────┬────────┘  │
│         │                  │                   │           │
│         ▼                  ▼                   ▼           │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              SessionTracker (内存)                    │  │
│  │   taskId ↔ sessionKey 双向映射 + retired 缓存        │  │
│  └──────────────────────────────────────────────────────┘  │
│         │                  │                   │           │
│         ▼                  ▼                   ▼           │
│  ┌──────────────────────────────────────────────────────┐  │
│  │           OpenClaw Session Client (CLI)               │  │
│  │   发消息到 session / 检查状态 / 恢复                   │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌──────────────┐   ┌──────────────┐                      │
│  │ RouterAPI    │   │ GatewayProxy │  ← LLM curl 调用     │
│  │ (Dashboard)  │   │ (/gateway/*) │                      │
│  └──────────────┘   └──────────────┘                      │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │        clawteam-auto-tracker (OpenClaw 插件)          │  │
│  │   before_tool_call / after_tool_call / persist        │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
└────────────────────────────────────────────────────────────┘
          │                                    ▲
          ▼                                    │
  ┌────────────────┐                ┌──────────────────┐
  │  远程 API      │                │  本地 OpenClaw    │
  │  Server        │                │  Agent Sessions   │
  └────────────────┘                └──────────────────┘
```

---

## 组件详解

### 1. 任务轮询 (TaskPollingLoop)

→ 详见 [TaskPoller.md](TaskPoller.md)

定时从 API 统一收件箱拉取新任务和消息，交给 Router 路由到 session。

- 间隔：`pollIntervalMs`（默认 5s），重叠保护
- `task_notification` → 获取完整 Task 对象 → `router.route(task)`
- `direct_message` → `router.routeMessage(message)`
- 路由成功后：`routedTasks.markRouted(taskId)` + ACK inbox 消息
- 防重复：`RoutedTasksTracker` 记录已路由 taskId（1h TTL）

### 2. 任务路由 (TaskRouter)

→ 详见 [TaskRouter.md](TaskRouter.md)

两阶段设计：`decide()` 纯逻辑决策 + `execute()` I/O 执行。根据 task.type 路由到 main session 或指定 sub-session，session 过期时尝试恢复或降级。

### 3. Session 跟踪 (SessionTracker)

→ 详见 [SessionTracker.md](SessionTracker.md)

纯内存双向映射 taskId ↔ sessionKey，所有组件共享。Gateway 重启后靠 Recovery Loop 从 API 重建。

### 4. 插件自动追踪 (clawteam-auto-tracker)

通过 OpenClaw 插件 Hook 自动完成 task 创建和 session 追踪，无需 LLM 输出特定格式或手动调用 API。

**插件 Hook 流程**：

```
1. Main session LLM 调用 sessions_spawn，params 中包含:
   _clawteam_role: "executor" | "sender"
   _clawteam_taskId: "<taskId>"          (executor 必须, sender 可选)
   _clawteam_from_bot_id: "<fromBotId>"  (非 sender 必须)

2. before_tool_call Hook (spawn 执行前):
   ├── 检测 _clawteam_role 参数，无则跳过（非 ClawTeam spawn）
   ├── sender 无 taskId → POST /gateway/tasks/create 自动创建任务
   │   └── 失败则 block spawn（不 fallback）
   ├── executor 无 taskId → block spawn
   ├── 非 sender 无 _clawteam_from_bot_id → block spawn
   ├── 按角色加载 task_system_prompt_executor.md 或 task_system_prompt_sender.md 模板，替换占位符:
   │   {{TASK_ID}}, {{ROLE}}, {{GATEWAY_URL}}, {{FROM_BOT_ID}}
   └── 将渲染后的模板 prepend 到 task 参数（子 session 收到的内容）

3. sessions_spawn 执行，子 session 收到注入了系统提示的 task 内容

4. after_tool_call Hook (spawn 完成后):
   ├── 检查 result.details.status === "accepted"
   ├── 取 childSessionKey
   └── POST /gateway/track-session { taskId, sessionKey, role }
       ├── executor: gateway 自动 accept + start + notify
       └── sender: gateway 追踪 + sync senderSessionKey

5. tool_result_persist Hook:
   └── 在 spawn 结果中追加 [ClawTeam] taskId: xxx
       （main session 可见，用于后续引用）
```

**插件源码**：`packages/openclaw-plugin/`（通过 `openclaw plugins install --link` 安装）

### 5. 心跳上报 (HeartbeatLoop)

→ 详见 [HeartbeatLoop.md](HeartbeatLoop.md)

每 30s 解析 session JSONL 日志推断状态，上报到 API。仅 CLI 模式。

### 6. 任务恢复 (StaleTaskRecoveryLoop)

→ 详见 [StaleTaskRecoveryLoop.md](StaleTaskRecoveryLoop.md)

检测异常 session，逐级恢复：nudge → restore → reset → fallback。同时负责 syncUntrackedTasks 和 sweepCancelledTasks。

### 7. HTTP 端点

→ 详见 [api_endopint.md](api_endopint.md)

- Router API：Dashboard 管理接口（`/status`, `/tasks`, `/sessions`, `/delegate-intent` 等）
- Gateway Proxy：LLM curl 代理（`/gateway/*`，自动注入认证头）
- WebSocket：实时事件推送（`/ws`）

### 8. 消息构建器

→ 详见 [消息构建器.md](消息构建器.md)

5 种消息模板：新任务、子任务、降级路由、DM 转发（有/无 taskId）。

---

## 完整任务生命周期

以一个从 Dashboard 发起的 intent 委托任务为例：

```
时间线                     委托方 Gateway                        执行方 Gateway
──────────────────────────────────────────────────────────────────────────

T+0s     Dashboard POST /delegate-intent
         ├── API 预创建 task (realTaskId)
         ├── 构建 proxy sub-session prompt
         ├── 发送到 main session
         └── 启动 linking interval (500ms)

T+3s     Main session LLM 调用 sessions_spawn
         ├── 插件 before_tool_call:
         │   └── 解析 _clawteam_role, 注入 taskId + 系统提示模板
         ├── spawn 执行，子 session 收到注入后的 task 内容
         └── 插件 after_tool_call:
             └── POST /gateway/track-session
                 → sessionTracker.track(intentId, childSession)

T+5s     linking interval 检测到 intentId 有 session
         ├── sessionTracker.track(realTaskId, sameSession)
         ├── 发送 deferred task_notification
         └── 清除 interval

T+10s                                         Poller 拉取到任务
                                              ├── router.route(task) → main session
                                              ├── routedTasks.markRouted(taskId)
                                              └── main session spawn sub-session
                                                  └── 插件 after_tool_call
                                                      → POST /gateway/track-session
                                                      → track(taskId, execSession)
                                                      → auto accept + start

T+15s                                         Sub-session 已自动 accept
                                              └── 开始执行任务（系统提示已注入）

T+60s                                         Sub-session 缺少信息
                                              └── DM 委托方 bot (通过 API)

T+65s    Poller 拉取到 DM
         ├── routeMessage(message)
         ├── getSessionForTask(realTaskId)
         │   → 找到 childSession ✓
         └── 发送到 proxy sub-session

T+70s    Proxy sub-session 无法回答
         └── POST /gateway/tasks/:id/need-human-input
             → task 状态变为 waiting_for_input

T+120s   Recovery tick
         └── task.status === waiting_for_input → 跳过 ✓

T+180s   人类在 Dashboard Inbox 回复
         ├── POST /tasks/:id/resume (带 humanInput)
         │   → API 写 humanInput 到 task.result
         │   → API 写 direct_message 到 toBotId inbox
         └── task 状态恢复为 processing

T+185s                                        Poller 拉取到 humanInput DM
                                              └── 路由到 executor sub-session

T+300s                                        Sub-session 完成任务
                                              └── POST /gateway/tasks/:id/complete
                                                  ├── API 更新状态为 completed
                                                  └── sessionTracker.untrack()
                                                      → 移入 retired (24h TTL)

T+330s   Recovery tick
         └── task 状态为 completed → 清理
             ├── sessionTracker.untrack()
             ├── routedTasks.remove()
             └── attemptTracker.remove()
```

---

## Delegate-Intent 链接机制

Intent 任务使用 `intentId`（如 `intent-1771733580956`）作为临时 ID。API 预创建了真实任务（`realTaskId`），需要将两者链接到同一个 session。

```
1. Dashboard → POST /delegate-intent
   └── API 预创建任务 → realTaskId
   └── 发送 prompt 到 main session，使用 intentId

2. 插件 after_tool_call 调用 /gateway/track-session
   └── sessionTracker.track(intentId, childSession)

3. Linking Interval (每 500ms):
   └── 检查 sessionTracker.getSessionForTask(intentId)
   └── 找到 → sessionTracker.track(realTaskId, sameSession)
   └── 发送 deferred task_notification (通知 executor 的 gateway)
   └── 清除 interval

4. 30s 安全阈值:
   └── 如果 sub-session 还没 spawn → 先发 notification（防任务卡死）

5. 120s 最终超时:
   └── 清除 interval（防内存泄漏）
```

---

## 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `pollIntervalMs` | 5000 | Poller 轮询间隔 |
| `heartbeatIntervalMs` | 30000 | 心跳上报间隔 |
| `recoveryIntervalMs` | 30000 | Recovery 检查间隔 |
| `stalenessThresholdMs` | 300000 (5min) | Session idle 多久算 stale |
| `toolCallingTimeoutMs` | 600000 (10min) | Tool calling 卡住多久算 stale |
| `maxRecoveryAttempts` | 3 | 最大恢复尝试次数 |
| `routedTasksTtlMs` | 3600000 (1h) | RoutedTasks 条目过期时间 |
| `retiredTtlMs` | 86400000 (24h) | Retired session 映射保留时间 |
| `linkingIntervalMs` | 500 | Delegate-intent 链接检查间隔 |
| `linkingTimeoutMs` | 120000 (2min) | 链接 interval 最终超时 |
| `notificationFallbackMs` | 30000 (30s) | 未 spawn 时安全发送 notification |

---

## 故障模式与应对

| 故障 | 影响 | 自动应对 |
|------|------|----------|
| Gateway 重启 | 内存映射全部丢失 | Recovery 的 syncUntrackedTasks 重建映射 |
| Session 崩溃 | 任务卡在 processing | Recovery 尝试 restore → nudge → reset → fallback |
| 插件 track-session 失败 | taskId 无法链接到 session | linking interval 30s 后仍发送 notification；Recovery 重建映射 |
| 插件 create-task 失败 | sender spawn 被 block | 插件返回 block + blockReason，LLM 可重试 |
| API 不可达 | 无法 poll/heartbeat/recover | 各循环独立容错，记录错误，下次重试 |
| LLM session 空转 | 浪费 token | Recovery 检测 idle 状态，nudge 提醒 |
| 恢复次数耗尽 | 任务无法完成 | 自动 fail/cancel，加入黑名单不再尝试 |
| 委托方 session idle | 正常等待执行方 | Recovery 识别委托方模式，跳过 |
| waiting_for_input | 等待人类回复 | Recovery 跳过，不干预 |
| 新注册 bot 后 botId 不生效 | 轮询用旧 botId，收不到新消息 | `/gateway/register` 成功后自动热更新所有组件的 botId |
