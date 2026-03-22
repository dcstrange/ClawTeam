# thread 参数详解：线程绑定机制

> ⚠️ Historical Notice: 本目录为历史方案调研，不代表当前线上实现。
> 当前实现请参考：`docs/Gateway/GATEWAY_TASK_MANAGEMENT.md`、`docs/Gateway/消息构建器.md`、`docs/task-operations/README.md`。

## 概述

`thread` 参数是 `sessions_spawn` 工具中的一个关键参数，用于控制子 session 是否绑定到通信平台的"线程"（thread）。这个机制允许子 session 在完成初始任务后继续保持活跃，并能够接收后续的交互消息。

## 什么是"线程绑定"（Thread Binding）？

### 基本概念

在消息平台（如 Discord、Slack、Telegram）中，**线程（thread）** 是一种组织对话的方式：

```
主频道/群组
├── 消息 1
├── 消息 2
└── 线程 A（从消息 2 派生）
    ├── 回复 1
    ├── 回复 2
    └── 回复 3
```

**线程绑定** 就是将一个 OpenClaw session 与平台的某个线程关联起来，使得：
- 该线程中的所有后续消息都路由到同一个 session
- 该 session 的回复都发送到该线程中
- 形成一个持久化的对话上下文

### 为什么需要线程绑定？

**场景 1：一次性任务（thread=false）**
```
用户: "分析这个代码库"
  ↓
spawn 子 session（thread=false）
  ↓
子 session 执行任务
  ↓
返回结果
  ↓
子 session 结束 ✓
```
- 任务完成后 session 立即结束
- 无法继续对话
- 适合：数据分析、报告生成、一次性计算

**场景 2：持久化会话（thread=true）**
```
用户: "启动调试会话"
  ↓
spawn 子 session（thread=true）
  ↓
创建 Discord 线程并绑定
  ↓
子 session 执行初始任务
  ↓
返回结果
  ↓
子 session 保持活跃 ✓
  ↓
用户在线程中: "检查变量 X"
  ↓
同一个子 session 响应
  ↓
用户在线程中: "设置断点"
  ↓
同一个子 session 响应
...（持续对话）
```
- Session 保持活跃等待后续消息
- 所有对话在同一个线程中进行
- 保持完整的上下文和状态
- 适合：交互式调试、长期监控、多轮对话任务

## thread 参数的工作原理

### 1. 参数定义

```typescript
thread?: boolean
```

- **默认值：** `false`
- **类型：** 可选布尔值
- **作用：** 请求将子 session 绑定到通信平台的线程

### 2. 执行流程

```
sessions_spawn({ task: "...", thread: true })
    ↓
检查是否有 channel 插件注册了 subagent_spawning hook
    ↓
    ├─ 没有 → 返回错误
    │   "thread=true is unavailable because no channel plugin
    │    registered subagent_spawning hooks."
    ↓
    └─ 有 → 调用 hook
        ↓
        检查配置是否允许线程绑定
        ↓
        ├─ 不允许 → 返回错误
        │   "Discord thread bindings are disabled"
        ↓
        └─ 允许 → 创建/绑定线程
            ↓
            在平台上创建新线程（或使用现有线程）
            ↓
            将 childSessionKey 与线程 ID 关联
            ↓
            返回 { status: "ok", threadBindingReady: true }
            ↓
            子 session 启动并绑定到该线程
            ↓
            后续消息自动路由到该 session
```

### 3. 核心代码实现

**检查 hook 是否存在：**
```typescript
// src/agents/subagent-spawn.ts:116-122
if (!hookRunner?.hasHooks("subagent_spawning")) {
  return {
    status: "error",
    error: "thread=true is unavailable because no channel plugin registered subagent_spawning hooks.",
  };
}
```

**调用 hook 创建线程绑定：**
```typescript
// src/agents/subagent-spawn.ts:125-138
const result = await hookRunner.runSubagentSpawning(
  {
    childSessionKey: params.childSessionKey,
    agentId: params.agentId,
    label: params.label,
    mode: params.mode,
    requester: params.requester,
    threadRequested: true,
  },
  {
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
  },
);
```

## Channel 插件的 subagent_spawning Hook

### Hook 定义

```typescript
// src/plugins/types.ts:564-583
export type PluginHookSubagentSpawningEvent = {
  childSessionKey: string;      // 子 session 的 key
  agentId: string;               // agent ID
  label?: string;                // session 标签
  mode: "run" | "session";       // 执行模式
  requester?: {
    channel?: string;            // 请求来源的 channel（如 "discord"）
    accountId?: string;          // 账户 ID
    to?: string;                 // 目标地址
    threadId?: string | number;  // 父线程 ID
  };
  threadRequested: boolean;      // 是否请求线程绑定
};

export type PluginHookSubagentSpawningResult =
  | {
      status: "ok";
      threadBindingReady?: boolean;  // 线程绑定是否就绪
    }
  | {
      status: "error";
      error: string;                 // 错误信息
    };
```

### Discord 插件实现示例

```typescript
// extensions/discord/src/subagent-hooks.ts:41-91
api.on("subagent_spawning", async (event) => {
  // 1. 检查是否请求线程绑定
  if (!event.threadRequested) {
    return;
  }

  // 2. 检查是否是 Discord channel
  const channel = event.requester?.channel?.trim().toLowerCase();
  if (channel !== "discord") {
    return;  // 让其他 channel 插件处理
  }

  // 3. 检查配置是否允许线程绑定
  const threadBindingFlags = resolveThreadBindingFlags(event.requester?.accountId);
  if (!threadBindingFlags.enabled) {
    return {
      status: "error",
      error: "Discord thread bindings are disabled"
    };
  }

  // 4. 检查是否允许 subagent spawn 使用线程
  if (!threadBindingFlags.spawnSubagentSessions) {
    return {
      status: "error",
      error: "Discord thread-bound subagent spawns are disabled"
    };
  }

  // 5. 创建并绑定 Discord 线程
  try {
    const binding = await autoBindSpawnedDiscordSubagent({
      accountId: event.requester?.accountId,
      channel: event.requester?.channel,
      to: event.requester?.to,
      threadId: event.requester?.threadId,
      childSessionKey: event.childSessionKey,
      agentId: event.agentId,
      label: event.label,
      boundBy: "system",
    });

    if (!binding) {
      return {
        status: "error",
        error: "Unable to create or bind a Discord thread"
      };
    }

    // 6. 返回成功
    return {
      status: "ok",
      threadBindingReady: true
    };
  } catch (err) {
    return {
      status: "error",
      error: `Discord thread bind failed: ${err.message}`
    };
  }
});
```

## 配置要求

### 全局配置

```json5
// ~/.openclaw/config.json
{
  "session": {
    "threadBindings": {
      "enabled": true,        // 全局启用线程绑定
      "ttlHours": 24          // 线程绑定的生存时间（小时）
    }
  }
}
```

### Discord 特定配置

```json5
{
  "channels": {
    "discord": {
      "threadBindings": {
        "enabled": true,                  // Discord 启用线程绑定
        "ttlHours": 24,                   // 线程绑定 TTL
        "spawnSubagentSessions": true     // 允许 sessions_spawn 使用线程绑定（必须）
      }
    }
  }
}
```

**关键配置项：**
- `session.threadBindings.enabled` - 全局开关
- `channels.discord.threadBindings.enabled` - Discord 开关
- `channels.discord.threadBindings.spawnSubagentSessions` - **必须设置为 true** 才能使用 `thread=true`

### 配置优先级

```
channels.discord.accounts[accountId].threadBindings.*
    ↓（如果未设置）
channels.discord.threadBindings.*
    ↓（如果未设置）
session.threadBindings.*
    ↓（如果未设置）
默认值
```

## thread 与 mode 的关系

### 自动推断规则

```typescript
// src/agents/subagent-spawn.ts:79-88
function resolveSpawnMode(params: {
  requestedMode?: SpawnSubagentMode;
  threadRequested: boolean;
}): SpawnSubagentMode {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  // 如果请求线程绑定，默认使用 session 模式
  return params.threadRequested ? "session" : "run";
}
```

### 参数组合规则

| thread | mode | 结果 | 说明 |
|--------|------|------|------|
| `false` | 未指定 | `mode="run"` | 一次性任务，完成后结束 |
| `false` | `"run"` | `mode="run"` | 明确指定一次性任务 |
| `false` | `"session"` | ❌ 错误 | `mode="session"` 必须配合 `thread=true` |
| `true` | 未指定 | `mode="session"` | 自动推断为持久化模式 |
| `true` | `"run"` | `mode="run"` | 可以，但不常见（线程绑定的一次性任务） |
| `true` | `"session"` | `mode="session"` | 标准的持久化会话 |

### 错误检查

```typescript
// src/agents/subagent-spawn.ts:176-180
if (spawnMode === "session" && !requestThreadBinding) {
  return {
    status: "error",
    error: 'mode="session" requires thread=true so the subagent can stay bound to a thread.',
  };
}
```

## 实际使用场景

### 场景 1：交互式调试会话

```typescript
// 启动调试 session
const result = await sessions_spawn({
  task: "Start an interactive debugging session for the authentication module",
  label: "Auth Debug Session",
  thread: true,
  mode: "session"
});

// 返回：
// {
//   status: "accepted",
//   childSessionKey: "agent:main:subagent:abc123...",
//   runId: "run-xyz789",
//   mode: "session",
//   note: "thread-bound session stays active after this task; continue in-thread for follow-ups."
// }
```

**在 Discord 中的表现：**
```
主频道
└── 🧵 新线程："Auth Debug Session"
    ├── Bot: "Debugging session started. Current breakpoints: ..."
    ├── 用户: "Show me the value of userToken"
    ├── Bot: "userToken = 'eyJhbGc...'"
    ├── 用户: "Step into validateToken()"
    └── Bot: "Stepping into validateToken()..."
```

### 场景 2：长期监控任务

```typescript
const result = await sessions_spawn({
  task: "Monitor the production server logs for errors and alert on anomalies",
  label: "Production Monitor",
  thread: true,
  mode: "session",
  runTimeoutSeconds: 0  // 无限期运行
});
```

**在 Discord 中的表现：**
```
主频道
└── 🧵 新线程："Production Monitor"
    ├── Bot: "Monitoring started. Watching /var/log/app.log"
    ├── Bot: "⚠️ Error detected: Connection timeout at 14:23:45"
    ├── 用户: "Show me the last 10 errors"
    ├── Bot: "Last 10 errors: ..."
    ├── 用户: "Pause monitoring"
    └── Bot: "Monitoring paused."
```

### 场景 3：多轮对话任务

```typescript
const result = await sessions_spawn({
  task: "Help me design a new API endpoint for user registration",
  label: "API Design Discussion",
  thread: true,
  mode: "session"
});
```

**在 Discord 中的表现：**
```
主频道
└── 🧵 新线程："API Design Discussion"
    ├── Bot: "Let's design the registration endpoint. What data do you need to collect?"
    ├── 用户: "Email, password, and optional phone number"
    ├── Bot: "Here's a proposed schema: ..."
    ├── 用户: "Add email verification"
    ├── Bot: "Updated schema with verification token: ..."
    └── 用户: "Looks good, generate the code"
```

### 场景 4：一次性任务（对比）

```typescript
// 不使用线程绑定
const result = await sessions_spawn({
  task: "Count all TODO comments in the codebase",
  thread: false  // 或省略
});

// 返回：
// {
//   status: "accepted",
//   childSessionKey: "agent:main:subagent:def456...",
//   runId: "run-abc123",
//   mode: "run",
//   note: "auto-announces on completion, do not poll/sleep. The response will be sent back as an user message."
// }
```

**在 Discord 中的表现：**
```
主频道
├── 用户: "Count all TODO comments"
└── Bot: "Found 47 TODO comments across 23 files."
    （任务完成，session 结束，没有创建线程）
```

## 线程绑定的生命周期

### 1. 创建阶段

```
sessions_spawn({ thread: true })
    ↓
调用 subagent_spawning hook
    ↓
Discord 插件创建新线程
    ↓
存储绑定关系：
{
  threadId: "1234567890",
  sessionKey: "agent:main:subagent:abc123",
  accountId: "discord-account-1",
  boundBy: "system",
  createdAt: "2024-01-01T00:00:00Z"
}
```

### 2. 活跃阶段

```
用户在线程中发送消息
    ↓
Discord 插件接收消息
    ↓
查找线程绑定关系
    ↓
找到 sessionKey: "agent:main:subagent:abc123"
    ↓
将消息路由到该 session
    ↓
Session 处理并回复
    ↓
回复发送到同一线程
```

### 3. 结束阶段

```
Session 结束（手动或超时）
    ↓
触发 subagent_ended hook
    ↓
Discord 插件解除线程绑定
    ↓
可选：发送告别消息
    ↓
可选：归档或删除线程
```

### TTL（生存时间）机制

```json5
{
  "channels": {
    "discord": {
      "threadBindings": {
        "ttlHours": 24  // 24 小时后自动解除绑定
      }
    }
  }
}
```

- 如果线程在 TTL 时间内没有活动，绑定会自动解除
- 可以通过 `/session ttl <duration>` 命令调整
- 设置为 `0` 表示永不过期

## 相关命令

### /focus 命令

手动将当前线程绑定到指定 session：

```
/focus agent:main:subagent:abc123
```

### /unfocus 命令

解除当前线程的绑定：

```
/unfocus
```

### /agents 命令

查看所有活跃的 session 和绑定状态：

```
/agents
```

输出示例：
```
Active Sessions:
- agent:main:subagent:abc123 (Debug Session)
  Bound to: Discord Thread #1234567890
  Status: Running
  Uptime: 15 minutes
```

### /session ttl 命令

查看或设置线程绑定的 TTL：

```
/session ttl          # 查看当前 TTL
/session ttl 48h      # 设置为 48 小时
/session ttl off      # 禁用 TTL
```

## 支持的平台

### 当前支持

| 平台 | 支持状态 | 配置路径 |
|------|---------|---------|
| Discord | ✅ 完全支持 | `channels.discord.threadBindings.*` |
| Slack | ⚠️ 部分支持 | `channels.slack.threadBindings.*` |
| Telegram | ❌ 不支持 | - |
| WhatsApp | ❌ 不支持 | - |

### 实现要求

要支持线程绑定，channel 插件必须：

1. **注册 `subagent_spawning` hook**
   ```typescript
   api.on("subagent_spawning", async (event) => {
     // 创建线程并返回绑定状态
   });
   ```

2. **注册 `subagent_ended` hook**
   ```typescript
   api.on("subagent_ended", (event) => {
     // 清理线程绑定
   });
   ```

3. **注册 `subagent_delivery_target` hook**
   ```typescript
   api.on("subagent_delivery_target", (event) => {
     // 解析消息应该发送到哪个线程
   });
   ```

4. **实现消息路由逻辑**
   - 接收平台消息时查找线程绑定
   - 将消息路由到正确的 session

## 常见错误和解决方案

### 错误 1：Hook 未注册

```json
{
  "status": "error",
  "error": "thread=true is unavailable because no channel plugin registered subagent_spawning hooks."
}
```

**原因：** 当前 channel 没有插件支持线程绑定

**解决方案：**
- 确认使用的是支持线程绑定的 channel（如 Discord）
- 检查 Discord 插件是否正确加载
- 如果是自定义 channel，需要实现相应的 hooks

### 错误 2：配置未启用

```json
{
  "status": "error",
  "error": "Discord thread bindings are disabled"
}
```

**原因：** 配置中禁用了线程绑定

**解决方案：**
```json5
{
  "channels": {
    "discord": {
      "threadBindings": {
        "enabled": true  // 启用
      }
    }
  }
}
```

### 错误 3：Subagent spawn 未启用

```json
{
  "status": "error",
  "error": "Discord thread-bound subagent spawns are disabled for this account"
}
```

**原因：** 未启用 subagent spawn 的线程绑定功能

**解决方案：**
```json5
{
  "channels": {
    "discord": {
      "threadBindings": {
        "enabled": true,
        "spawnSubagentSessions": true  // 必须启用
      }
    }
  }
}
```

### 错误 4：mode 和 thread 冲突

```json
{
  "status": "error",
  "error": "mode=\"session\" requires thread=true so the subagent can stay bound to a thread."
}
```

**原因：** 使用了 `mode="session"` 但没有设置 `thread=true`

**解决方案：**
```typescript
// 错误
sessions_spawn({
  task: "...",
  mode: "session"  // ❌ 缺少 thread: true
});

// 正确
sessions_spawn({
  task: "...",
  mode: "session",
  thread: true  // ✅
});
```

## 最佳实践

### 1. 明确指定 mode

虽然 `thread=true` 会自动推断 `mode="session"`，但明确指定更清晰：

```typescript
// 推荐
sessions_spawn({
  task: "Interactive task",
  thread: true,
  mode: "session"  // 明确指定
});
```

### 2. 使用有意义的 label

Label 会显示在线程标题中，使用描述性的名称：

```typescript
sessions_spawn({
  task: "Debug authentication flow",
  label: "🐛 Auth Debug - User #12345",  // 清晰的标签
  thread: true,
  mode: "session"
});
```

### 3. 设置合理的超时

对于持久化 session，考虑设置超时以防止资源泄漏：

```typescript
sessions_spawn({
  task: "Monitor logs",
  thread: true,
  mode: "session",
  runTimeoutSeconds: 3600  // 1 小时后自动结束
});
```

### 4. 使用 cleanup 策略

对于临时的线程绑定 session，考虑自动清理：

```typescript
sessions_spawn({
  task: "Temporary analysis",
  thread: true,
  mode: "session",
  cleanup: "delete"  // 结束后删除
});
```

### 5. 检查返回状态

始终检查返回的状态，处理可能的错误：

```typescript
const result = await sessions_spawn({
  task: "...",
  thread: true,
  mode: "session"
});

if (result.status === "error") {
  console.error("Failed to create thread-bound session:", result.error);
  // 降级到非线程模式
  return await sessions_spawn({
    task: "...",
    thread: false
  });
}
```

## 总结

### thread=false（默认）
- ❌ 不创建线程绑定
- ❌ Session 完成任务后结束
- ❌ 无法继续对话
- ✅ 适合一次性任务
- ✅ 资源占用少

### thread=true
- ✅ 创建平台线程并绑定
- ✅ Session 保持活跃
- ✅ 可以继续对话
- ✅ 保持完整上下文
- ⚠️ 需要 channel 插件支持
- ⚠️ 需要正确配置
- ⚠️ 资源占用较多

### 关键要点

1. **线程绑定 = 持久化对话通道**
2. **需要 channel 插件实现 subagent_spawning hook**
3. **必须在配置中启用 `spawnSubagentSessions`**
4. **`mode="session"` 必须配合 `thread=true`**
5. **适合交互式、长期运行的任务**
