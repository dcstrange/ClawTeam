# sessions_spawn 工具参数和返回值说明

> ⚠️ Historical Notice: 本目录为历史方案调研，不代表当前线上实现。
> 当前实现请参考：`docs/Gateway/GATEWAY_TASK_MANAGEMENT.md`、`docs/Gateway/消息构建器.md`、`docs/task-operations/README.md`。

## 概述

`sessions_spawn` 是 OpenClaw 中用于创建子 session 的核心工具。它允许在隔离的 session 中生成子 agent，支持一次性执行（run 模式）和持久化会话（session 模式）。

**源码位置：**
- Tool 定义：`src/agents/tools/sessions-spawn-tool.ts`
- 核心实现：`src/agents/subagent-spawn.ts`

## 输入参数（SessionsSpawnToolSchema）

### 必需参数

| 参数名 | 类型 | 说明 | 示例 |
|-------|------|------|------|
| `task` | `string` | 要执行的任务描述（必需） | `"Analyze the codebase and find all TODO comments"` |

### 可选参数

| 参数名 | 类型 | 默认值 | 说明 | 示例 |
|-------|------|--------|------|------|
| `label` | `string` | 无 | 子 session 的标签，用于识别和管理 | `"Code Analysis Task"` |
| `agentId` | `string` | 当前 agent ID | 指定要使用的 agent ID | `"research"`, `"coding"` |
| `model` | `string` | 继承父 session | 指定使用的模型 | `"anthropic/claude-opus-4"`, `"openai/gpt-4"` |
| `thinking` | `string` | 无 | 思考模式级别 | `"off"`, `"low"`, `"medium"`, `"high"` |
| `runTimeoutSeconds` | `number` | 无限制 | 运行超时时间（秒），最小值 0 | `600` (10分钟) |
| `timeoutSeconds` | `number` | 无限制 | 向后兼容的超时参数（已废弃，使用 runTimeoutSeconds） | `300` |
| `thread` | `boolean` | `false` | 是否绑定到线程（用于持久化 session） | `true` |
| `mode` | `"run" \| "session"` | 自动推断 | 执行模式：`run` 一次性，`session` 持久化 | `"run"`, `"session"` |
| `cleanup` | `"delete" \| "keep"` | `"keep"` | session 结束后的清理策略 | `"delete"`, `"keep"` |

### 参数详细说明

#### 1. task（必需）
```typescript
task: string
```
- 要分配给子 session 的任务描述
- 会被包装在系统提示中发送给子 agent
- 应该清晰、具体地描述要完成的工作

**示例：**
```json
{
  "task": "Search the codebase for all API endpoints and generate a documentation file"
}
```

#### 2. label（可选）
```typescript
label?: string
```
- 为子 session 提供一个人类可读的标签
- 用于在日志、监控和管理界面中识别 session
- 如果不提供，session 将使用自动生成的 key

**示例：**
```json
{
  "task": "Run tests",
  "label": "Unit Test Execution"
}
```

#### 3. agentId（可选）
```typescript
agentId?: string
```
- 指定要使用的 agent ID
- 默认使用当前 agent 的 ID
- 跨 agent spawn 需要在配置中明确允许（`subagents.allowAgents`）

**权限控制：**
- 默认只允许 spawn 到相同的 agent
- 需要在配置中设置 `allowAgents: ["*"]` 或指定允许的 agent 列表

**示例：**
```json
{
  "task": "Research the topic",
  "agentId": "research"
}
```

#### 4. model（可选）
```typescript
model?: string
```
- 覆盖子 session 使用的模型
- 格式：`provider/model` 或直接 `model`
- 如果不指定，继承父 session 的模型配置

**示例：**
```json
{
  "task": "Complex reasoning task",
  "model": "anthropic/claude-opus-4"
}
```

#### 5. thinking（可选）
```typescript
thinking?: string
```
- 设置思考模式级别
- 有效值：`"off"`, `"low"`, `"medium"`, `"high"`
- 不同模型支持的级别可能不同

**示例：**
```json
{
  "task": "Solve complex problem",
  "thinking": "high"
}
```

#### 6. runTimeoutSeconds（可选）
```typescript
runTimeoutSeconds?: number
```
- 设置子 session 的运行超时时间（秒）
- 最小值：0（无限制）
- 超时后 session 会被终止

**示例：**
```json
{
  "task": "Quick analysis",
  "runTimeoutSeconds": 300
}
```

#### 7. thread（可选）
```typescript
thread?: boolean
```
- 是否将子 session 绑定到线程
- `true`：子 session 可以接收后续消息（持久化）
- `false`：子 session 执行完任务后结束
- 需要 channel 插件支持 `subagent_spawning` hook

**示例：**
```json
{
  "task": "Start monitoring service",
  "thread": true,
  "mode": "session"
}
```

#### 8. mode（可选）
```typescript
mode?: "run" | "session"
```
- `"run"`：一次性执行模式，任务完成后 session 结束
- `"session"`：持久化模式，session 保持活跃等待后续交互
- 如果不指定：
  - `thread=true` 时默认为 `"session"`
  - `thread=false` 时默认为 `"run"`
- **注意：** `mode="session"` 必须配合 `thread=true` 使用

**示例：**
```json
{
  "task": "Interactive debugging session",
  "thread": true,
  "mode": "session"
}
```

#### 9. cleanup（可选）
```typescript
cleanup?: "delete" | "keep"
```
- `"delete"`：session 结束后删除所有数据
- `"keep"`：保留 session 数据用于审计或调试
- 默认值：
  - `mode="session"` 时强制为 `"keep"`
  - `mode="run"` 时默认为 `"keep"`

**示例：**
```json
{
  "task": "Temporary calculation",
  "mode": "run",
  "cleanup": "delete"
}
```

## 返回结果（SpawnSubagentResult）

### 成功返回（status: "accepted"）

```typescript
{
  status: "accepted",
  childSessionKey: string,
  runId: string,
  mode: "run" | "session",
  note: string,
  modelApplied?: boolean
}
```

| 字段 | 类型 | 说明 |
|-----|------|------|
| `status` | `"accepted"` | 表示 spawn 请求已被接受 |
| `childSessionKey` | `string` | 子 session 的唯一标识符 |
| `runId` | `string` | 本次运行的唯一 ID |
| `mode` | `"run" \| "session"` | 实际使用的执行模式 |
| `note` | `string` | 提示信息，说明 session 的行为 |
| `modelApplied` | `boolean?` | 是否成功应用了模型覆盖 |

**note 字段的值：**
- `mode="run"`: `"auto-announces on completion, do not poll/sleep. The response will be sent back as an user message."`
- `mode="session"`: `"thread-bound session stays active after this task; continue in-thread for follow-ups."`

**示例：**
```json
{
  "status": "accepted",
  "childSessionKey": "agent:main:subagent:a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "runId": "run-1234567890",
  "mode": "run",
  "note": "auto-announces on completion, do not poll/sleep. The response will be sent back as an user message.",
  "modelApplied": true
}
```

### 权限拒绝（status: "forbidden"）

```typescript
{
  status: "forbidden",
  error: string
}
```

| 字段 | 类型 | 说明 |
|-----|------|------|
| `status` | `"forbidden"` | 表示请求被权限系统拒绝 |
| `error` | `string` | 拒绝原因的详细说明 |

**常见的 forbidden 错误：**

1. **超过最大 spawn 深度：**
```json
{
  "status": "forbidden",
  "error": "sessions_spawn is not allowed at this depth (current depth: 3, max: 3)"
}
```

2. **超过最大子 session 数量：**
```json
{
  "status": "forbidden",
  "error": "sessions_spawn has reached max active children for this session (5/5)"
}
```

3. **跨 agent spawn 未授权：**
```json
{
  "status": "forbidden",
  "error": "agentId is not allowed for sessions_spawn (allowed: research, coding)"
}
```

### 错误返回（status: "error"）

```typescript
{
  status: "error",
  error: string,
  childSessionKey?: string,
  runId?: string
}
```

| 字段 | 类型 | 说明 |
|-----|------|------|
| `status` | `"error"` | 表示执行过程中发生错误 |
| `error` | `string` | 错误信息 |
| `childSessionKey` | `string?` | 如果已创建 session，返回其 key |
| `runId` | `string?` | 如果已分配 run ID，返回该 ID |

**常见的 error 错误：**

1. **无效的 thinking 级别：**
```json
{
  "status": "error",
  "error": "Invalid thinking level \"invalid\". Use one of: off, low, medium, high."
}
```

2. **mode 和 thread 参数冲突：**
```json
{
  "status": "error",
  "error": "mode=\"session\" requires thread=true so the subagent can stay bound to a thread."
}
```

3. **线程绑定失败：**
```json
{
  "status": "error",
  "error": "thread=true is unavailable because no channel plugin registered subagent_spawning hooks.",
  "childSessionKey": "agent:main:subagent:..."
}
```

4. **Gateway 调用失败：**
```json
{
  "status": "error",
  "error": "Failed to create session: connection timeout",
  "childSessionKey": "agent:main:subagent:..."
}
```

## 完整使用示例

### 示例 1：简单的一次性任务

```typescript
// 输入
{
  "task": "Count all TypeScript files in the src directory"
}

// 输出
{
  "status": "accepted",
  "childSessionKey": "agent:main:subagent:12345678-1234-1234-1234-123456789abc",
  "runId": "run-1234567890",
  "mode": "run",
  "note": "auto-announces on completion, do not poll/sleep. The response will be sent back as an user message."
}
```

### 示例 2：带标签和超时的任务

```typescript
// 输入
{
  "task": "Run all unit tests and report failures",
  "label": "Unit Test Suite",
  "runTimeoutSeconds": 600,
  "cleanup": "delete"
}

// 输出
{
  "status": "accepted",
  "childSessionKey": "agent:main:subagent:87654321-4321-4321-4321-cba987654321",
  "runId": "run-0987654321",
  "mode": "run",
  "note": "auto-announces on completion, do not poll/sleep. The response will be sent back as an user message."
}
```

### 示例 3：持久化 session（需要线程支持）

```typescript
// 输入
{
  "task": "Start an interactive debugging session",
  "label": "Debug Session",
  "thread": true,
  "mode": "session"
}

// 输出
{
  "status": "accepted",
  "childSessionKey": "agent:main:subagent:abcdef12-3456-7890-abcd-ef1234567890",
  "runId": "run-1122334455",
  "mode": "session",
  "note": "thread-bound session stays active after this task; continue in-thread for follow-ups."
}
```

### 示例 4：跨 agent spawn（需要权限配置）

```typescript
// 输入
{
  "task": "Research the latest AI developments",
  "agentId": "research",
  "model": "anthropic/claude-opus-4",
  "thinking": "high"
}

// 输出（成功）
{
  "status": "accepted",
  "childSessionKey": "agent:research:subagent:fedcba98-7654-3210-fedc-ba9876543210",
  "runId": "run-5544332211",
  "mode": "run",
  "note": "auto-announces on completion, do not poll/sleep. The response will be sent back as an user message.",
  "modelApplied": true
}

// 输出（权限拒绝）
{
  "status": "forbidden",
  "error": "agentId is not allowed for sessions_spawn (allowed: main)"
}
```

### 示例 5：超过深度限制

```typescript
// 输入（在深度 3 的 session 中调用）
{
  "task": "Nested task"
}

// 输出
{
  "status": "forbidden",
  "error": "sessions_spawn is not allowed at this depth (current depth: 3, max: 3)"
}
```

### 示例 6：无效参数

```typescript
// 输入
{
  "task": "Some task",
  "mode": "session"
  // 缺少 thread: true
}

// 输出
{
  "status": "error",
  "error": "mode=\"session\" requires thread=true so the subagent can stay bound to a thread."
}
```

## Hook 拦截时的数据结构

### before_tool_call Hook

```typescript
event: {
  toolName: "sessions_spawn",
  params: {
    task: string,
    label?: string,
    agentId?: string,
    model?: string,
    thinking?: string,
    runTimeoutSeconds?: number,
    thread?: boolean,
    mode?: "run" | "session",
    cleanup?: "delete" | "keep"
  },
  toolCallId: string
}

ctx: {
  toolName: "sessions_spawn"
}
```

### after_tool_call Hook

```typescript
event: {
  toolName: "sessions_spawn",
  params: {
    task: string,
    label?: string,
    agentId?: string,
    model?: string,
    thinking?: string,
    runTimeoutSeconds?: number,
    thread?: boolean,
    mode?: "run" | "session",
    cleanup?: "delete" | "keep"
  },
  result: {
    status: "accepted" | "forbidden" | "error",
    childSessionKey?: string,
    runId?: string,
    mode?: "run" | "session",
    note?: string,
    modelApplied?: boolean,
    error?: string
  },
  durationMs?: number,
  error?: Error
}

ctx: {
  toolName: "sessions_spawn",
  agentId?: string,
  sessionKey?: string
}
```

## 配置相关

### 允许跨 agent spawn

在 `~/.openclaw/config.json` 中配置：

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "subagents": {
          "allowAgents": ["*"]  // 允许所有 agent
          // 或
          // "allowAgents": ["research", "coding"]  // 只允许特定 agent
        }
      }
    ]
  }
}
```

### 设置深度和并发限制

```json
{
  "agents": {
    "defaults": {
      "subagents": {
        "maxSpawnDepth": 3,        // 最大嵌套深度
        "maxChildrenPerAgent": 5,  // 每个 agent 最多同时运行的子 session 数
        "thinking": "medium"       // 默认思考级别
      }
    }
  }
}
```

## 最佳实践

### 1. 选择合适的 mode

- **使用 `mode="run"`（一次性任务）：**
  - 数据分析、报告生成
  - 测试执行
  - 代码审查
  - 文件处理

- **使用 `mode="session"`（持久化会话）：**
  - 交互式调试
  - 长期监控任务
  - 需要多轮对话的任务
  - 状态保持的服务

### 2. 设置合理的超时

```typescript
{
  "task": "Quick file search",
  "runTimeoutSeconds": 60  // 1 分钟足够
}

{
  "task": "Full codebase analysis",
  "runTimeoutSeconds": 1800  // 30 分钟
}
```

### 3. 使用 label 便于管理

```typescript
{
  "task": "Run integration tests",
  "label": `Integration Tests - ${new Date().toISOString()}`
}
```

### 4. 合理使用 cleanup

```typescript
// 临时任务，自动清理
{
  "task": "Calculate sum",
  "cleanup": "delete"
}

// 重要任务，保留记录
{
  "task": "Deploy to production",
  "cleanup": "keep"
}
```

### 5. 错误处理

```typescript
const result = await sessions_spawn({
  task: "Some task"
});

if (result.status === "forbidden") {
  console.error("Permission denied:", result.error);
} else if (result.status === "error") {
  console.error("Execution error:", result.error);
} else {
  console.log("Spawned successfully:", result.childSessionKey);
}
```

## 常见问题

### Q1: 为什么 mode="session" 必须配合 thread=true？

A: `session` 模式表示持久化会话，需要能够接收后续消息。`thread=true` 确保 session 绑定到一个线程，使得后续消息能够路由到正确的 session。

### Q2: childSessionKey 的格式是什么？

A: 格式为 `agent:{agentId}:subagent:{uuid}`，例如：
```
agent:main:subagent:12345678-1234-1234-1234-123456789abc
```

### Q3: 如何知道子 session 何时完成？

A: 对于 `mode="run"`，子 session 完成后会自动将结果发送回父 session（通过 `subagent_ended` hook）。不需要轮询。

### Q4: 可以同时 spawn 多少个子 session？

A: 默认限制：
- 最大深度：3 层
- 每个 agent 最多同时运行：5 个子 session

可以在配置中调整这些限制。

### Q5: 如何取消正在运行的子 session？

A: 可以通过 gateway API 调用 `sessions.delete` 方法：
```typescript
await callGateway({
  method: "sessions.delete",
  params: {
    key: childSessionKey,
    emitLifecycleHooks: true
  }
});
```

## 相关工具

- `sessions_send` - 向指定 session 发送消息
- `sessions_list` - 列出所有活跃的 session
- `sessions_history` - 获取 session 的历史记录
- `session_status` - 查询 session 的状态

## 参考资源

- 源码：`src/agents/tools/sessions-spawn-tool.ts`
- 核心实现：`src/agents/subagent-spawn.ts`
- 测试用例：`src/agents/openclaw-tools.subagents.sessions-spawn.*.test.ts`
- Hook 系统：`src/plugins/hook-runner-global.ts`
