# TaskPollingLoop — 统一收件箱轮询

> ⚠️ Historical Notice: 本文档含历史语义，可能与当前实现不一致。
> 当前规范请优先参考：`docs/task-operations/README.md`、`docs/api-reference/api-endpoints.md`、`docs/Gateway/GATEWAY_TASK_MANAGEMENT.md`。

> 源码：`packages/clawteam-gateway/src/polling/task-poller.ts`

## 职责

定时从远程 API Server 的统一收件箱（`GET /api/v1/messages/inbox`）拉取新消息，根据消息类型分发到 TaskRouter 进行路由。是 Gateway 发现新任务和 DM 的唯一入口。

---

## 运行条件

- 启动时立即执行一次，然后按 `pollIntervalMs`（默认 5s）间隔重复
- 重叠保护：`isPolling` 标志防止上一次 poll 未完成时重入
- 继承 `EventEmitter`，每次 poll 完成后发出 `poll_complete` 事件

---

## 内部状态

| 数据 | 类型 | 说明 |
|------|------|------|
| `routedTasks` | `RoutedTasksTracker` | 已路由任务的去重集合（TTL 1h），与 Recovery Loop 共享 |
| `isPolling` | boolean | 重叠保护标志 |
| `consecutiveErrors` | number | 连续错误计数，达到 5 次时记录 warn |

---

## 处理流程

```
每 5s 执行一次 pollOnce()
    │
    ├── isPolling === true → 跳过本次（重叠保护）
    │
    ▼
clawteamApi.pollInbox(limit)
    → GET /api/v1/messages/inbox?limit=10
    │
    ├── 无消息 → 重置 consecutiveErrors，返回
    │
    └── 有消息 → 逐条处理:
```

### 消息类型分发

```
对每条 inbox 消息:
    │
    ├── type: "task_notification"
    │     ├── 从 content.taskId 或 msg.taskId 提取 taskId
    │     ├── taskId 缺失 → 跳过 (warn)
    │     ├── clawteamApi.getTask(taskId) 获取完整 Task
    │     ├── Task 不存在 → 跳过 (warn)
    │     ├── router.route(task) → 路由到 session
    │     │     ├── 成功 → routedTasks.markRouted() + ACK 消息
    │     │     ├── session_busy → 不 ACK，下次 poll 重试
    │     │     └── 其他失败 → warn，不 ACK
    │     └── ACK 失败 → warn（best-effort，不影响路由结果）
    │
    ├── type: "delegate_intent"
    │     ├── router.routeDelegateIntent(msg)
    │     │     ├── 成功 → ACK 消息
    │     │     └── 失败 → warn，不 ACK
    │     └── delegate_intent 不经过 routedTasks 去重
    │
    ├── type: "direct_message"
    │     ├── router.routeMessage(msg)
    │     │     ├── 成功 → ACK 消息
    │     │     └── 失败 → warn，不 ACK
    │     └── DM 不经过 routedTasks 去重
    │
    └── 其他类型 (broadcast/system)
          → 跳过 (debug 日志)
```

### Poll 完成后

```
统计 routed / failed / skipped
    │
    ├── 发出 'poll_complete' 事件 (WebSocket 广播)
    ├── 输出 visual 摘要（控制台彩色输出）
    └── routedTasks.cleanup() — 清理过期的去重条目
```

---

## ACK 机制

- 路由成功后才 ACK inbox 消息（`clawteamApi.ackMessage(messageId)`）
- ACK 是 best-effort：失败只 warn，不重试
- 未 ACK 的消息保留在 inbox 中，下次 poll 会再次拉取
- `session_busy` 时特意不 ACK，利用 inbox 保留实现自动重试

---

## 去重 (RoutedTasksTracker)

> 源码：`packages/clawteam-gateway/src/routing/routed-tasks.ts`

任务在 pending → accepted 之间可能被多次 poll 到（尚未被 sub-session accept），`RoutedTasksTracker` 防止重复路由。

| 方法 | 说明 |
|------|------|
| `markRouted(taskId)` | 记录 taskId + 当前时间戳 |
| `isRouted(taskId)` | 检查是否在集合中且未过期 |
| `remove(taskId)` | 移除条目（Recovery 重置任务后调用） |
| `cleanup()` | 删除过期条目，返回清理数量 |

- TTL：默认 1h（`routedTasksTtlMs`）
- 与 `StaleTaskRecoveryLoop` 共享同一实例
- Recovery Loop 重置任务时调用 `remove()` 使 Poller 可重新路由

---

## 容错

| 场景 | 行为 |
|------|------|
| API 不可达 | catch 后 `consecutiveErrors++`，下次 poll 重试 |
| 连续 5 次错误 | 额外 warn 日志（但不停止 polling） |
| 单条消息处理失败 | 不影响其他消息，继续循环 |
| ACK 失败 | warn 日志，消息留在 inbox 下次重试 |
| session_busy | 不 ACK，消息留在 inbox 下次自动重试 |

---

## 事件

| 事件 | 触发时机 | 数据 |
|------|---------|------|
| `poll_complete` | 每次 poll 处理完成 | `{ fetched, routed, failed, skipped }` |

**消费者**：`RouterApiServer` 监听此事件，通过 WebSocket 广播给 Dashboard。

---

## 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `pollIntervalMs` | 5000 (5s) | 轮询间隔 |
| `pollLimit` | 10 | 每次 poll 拉取的最大消息数 |
| `routedTasksTtlMs` | 3600000 (1h) | RoutedTasks 去重条目过期时间 |

---

## 与其他组件的关系

```
ClawTeamApiClient ←── pollInbox() ──── TaskPollingLoop
                                              │
                                              ├── router.route(task)          → TaskRouter
                                              ├── router.routeDelegateIntent(msg) → TaskRouter
                                              ├── router.routeMessage(msg)    → TaskRouter
                                              ├── routedTasks.markRouted()    → RoutedTasksTracker (共享)
                                              └── emit('poll_complete')       → RouterApiServer → WebSocket
```

- **ClawTeamApiClient**：通过 `pollInbox()` 和 `getTask()` 与远程 API 交互
- **TaskRouter**：接收路由请求，决策并发送到 OpenClaw session
- **RoutedTasksTracker**：共享实例，Poller 写入、Recovery Loop 可清除
- **RouterApiServer**：监听 `poll_complete` 事件广播给 Dashboard
