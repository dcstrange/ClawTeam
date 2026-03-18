# TaskRouter — 路由决策与执行

> 源码：`packages/clawteam-gateway/src/routing/router.ts`

## 职责

决定任务发送到哪个 OpenClaw session，构建 prompt，执行发送。继承 EventEmitter，路由完成后发出事件供 WebSocket 广播。

---

## 两阶段设计

| 阶段 | 方法 | 说明 |
|------|------|------|
| 决策 | `decide(task)` | 纯逻辑，无 I/O。根据 task.type 和参数决定目标 session |
| 执行 | `execute(decision)` | 发送消息到 OpenClaw session，处理失败降级 |
| 便捷 | `route(task)` | decide + execute 的组合 |
| DM | `routeMessage(message)` | 路由统一收件箱中的 direct_message |

---

## 路由决策逻辑

```
task.type === 'new' (或未设置)
    → 发送到 main session
    → main session LLM 负责 spawn sub-session

task.type === 'sub-task'
    ├── 有 parameters.targetSessionKey
    │     → 发送到指定 session
    │
    ├── 有 parentTaskId
    │     → 从 SessionTracker 查找 parent 任务的 session
    │     → 找到 → 发送到同一 session
    │     → 找不到 → 降级到 main session
    │
    └── 都没有 → main session
```

**Session 过期处理**：

```
目标 session 不存活
    ├── 尝试 restoreSession()（CLI 模式）
    │     → 成功 → 重试发送
    │     → 失败 → 降级到 main session（带 parent context）
    └── HTTP 模式 → 直接降级到 main
```

---

## 消息构建器

详见 [消息构建器.md](消息构建器.md)。

### `buildNewTaskMessage(task)`

新任务发送到 main session，指示 LLM spawn sub-session 执行。

关键内容：
- spawn 参数的 task 字符串包含 `[CLAWTEAM_META]` 块和任务事实
- 插件 `clawteam-auto-tracker` 按角色自动注入 `task_system_prompt_executor.md` 或 `task_system_prompt_sender.md` 模板到 task 参数
- 插件自动调用 `/gateway/track-session` 完成 accept + start + notify
- 第二步：通过 `sessions_send` 发送任务详情（prompt、capability、parameters）到子 session

### `buildSubTaskMessage(task)`

子任务发送到已有 session。

关键内容：
- 包含 parentTaskId 引用
- Gateway 已自动 accept（sub-task 不需要手动 accept）
- 信息获取层级：DM 委托方 → `/need-human-input` 问自己的人类

### `buildFallbackMessage(task)`

目标 session 已死时，降级到 main session。

关键内容：
- 从 API 获取 parent task context（如果有 parentTaskId）
- 使用与 `buildNewTaskMessage` 相同的插件 spawn 流程
- 包含 parent result 作为上下文

### `buildTaskContextMessagePrompt(message, task)`

带 taskId 的 DM 转发到对应 sub-session。

关键内容：
- 显示任务状态和 capability
- 终态任务不允许回复
- 提供 curl 回复模板

### `buildDirectMessagePrompt(message)`

无 taskId 的普通 DM 发送到 main session。

---

## DM 消息路由

```
收到 direct_message
    │
    ├── 有 taskId
    │     → SessionTracker.getSessionForTask(taskId)
    │     ├── 找到 session → 发送到该 sub-session
    │     └── 找不到 → 降级到 main session（带 task context）
    │
    └── 无 taskId
          → 发送到 main session
```

---

## 事件

| 事件 | 触发时机 | 数据 |
|------|---------|------|
| `task_routed` | 任务路由完成 | `{taskId, action, sessionKey, success, reason}` |
| `message_routed` | DM 路由完成 | `{messageId, taskId, sessionKey, success}` |
