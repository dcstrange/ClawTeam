# OpenClaw sessions_spawn Hook 扩展方案：自动创建任务并追踪 Session

> ⚠️ Historical Notice: 本目录为历史方案调研，不代表当前线上实现。
> 当前实现请参考：`docs/Gateway/GATEWAY_TASK_MANAGEMENT.md`、`docs/Gateway/消息构建器.md`、`docs/task-operations/README.md`。

## 1. 需求

每次调用 `sessions_spawn` 时，自动完成以下流程：

```
before_tool_call
  → 调用 create_task() 生成 clawteam_taskId
  → 将 taskId 注入到 params 中传递给 after hook
      ↓
sessions_spawn 正常执行（忽略注入的额外字段）
      ↓
after_tool_call
  → 从 params 中取出 taskId
  → 从返回结果中拿到 childSessionKey
  → 调用 track_session(taskId, childSessionKey)
```

用户无需做任何改动，正常调用 `sessions_spawn` 即可。

---

## 2. 技术可行性（源码验证）

以下每条结论均已逐行对照源码确认。

### 2.1 sessions_spawn 可以被 Hook 拦截

所有通过 `createOpenClawTools` 创建的工具（包括 `sessions_spawn`）都经过统一的 tool adapter 层（`src/agents/pi-tool-definition-adapter.ts:99-186`），该层在执行前后分别调用 `before_tool_call` 和 `after_tool_call` hook。

源码路径：
- Tool 定义：`src/agents/tools/sessions-spawn-tool.ts`
- Tool adapter：`src/agents/pi-tool-definition-adapter.ts`
- Hook runner：`src/plugins/hooks.ts`
- Hook 类型定义：`src/plugins/types.ts`

### 2.2 Hook 执行模型

| Hook | 执行模型 | 源码位置 | 含义 |
|------|---------|---------|------|
| `before_tool_call` | **顺序执行** | `hooks.ts:424` → `runModifyingHook` → `for...of` | `await create_task()` 安全，不会竞态 |
| `after_tool_call` | **并行执行** | `hooks.ts:444` → `runVoidHook` → `Promise.all` | 单插件场景无影响 |

### 2.3 Hook Event 类型定义

```typescript
// src/plugins/types.ts:479-497

// before_tool_call 收到的 event
type PluginHookBeforeToolCallEvent = {
  toolName: string;                    // "sessions_spawn"
  params: Record<string, unknown>;     // { task, label, agentId, ... }
  // ⚠️ 没有 toolCallId
};

// after_tool_call 收到的 event
type PluginHookAfterToolCallEvent = {
  toolName: string;                    // "sessions_spawn"
  params: Record<string, unknown>;     // 与 before 一致（当 hook 不修改 params 时）
  result?: unknown;                    // AgentToolResult 对象（见 2.4）
  error?: string;                      // 运行时异常时有值
  durationMs?: number;
  // ⚠️ 没有 toolCallId
};

// 两个 hook 共用的 ctx
type PluginHookToolContext = {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
};
```

### 2.4 event.result 的实际结构（关键）

`sessions_spawn` 的 execute 返回 `jsonResult(result)`（`sessions-spawn-tool.ts:90`）。

`jsonResult` 会包一层（`common.ts:212-222`）：

```typescript
function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,  // ← SpawnSubagentResult 在这里
  };
}
```

所以 `after_tool_call` 中 `event.result` 的实际结构是：

```typescript
event.result = {
  content: [{ type: "text", text: "{\"status\":\"accepted\",...}" }],
  details: {                          // ← 要通过 .details 访问
    status: "accepted",
    childSessionKey: "agent:main:subagent:abc123",
    runId: "run-xyz",
    mode: "run",
    note: "auto-announces on completion...",
    modelApplied: true
  }
}
```

正确的访问方式：

```typescript
// ❌ 错误
(event.result as any)?.status
(event.result as any)?.childSessionKey

// ✅ 正确
const details = (event.result as any)?.details;
details?.status            // "accepted" | "forbidden" | "error"
details?.childSessionKey   // "agent:main:subagent:abc123"
```

### 2.5 异常场景下的 event

当 `sessions_spawn` 内部抛出运行时异常时（`pi-tool-definition-adapter.ts:165-176`）：

```typescript
// event.result 为 undefined
// event.error 为错误信息字符串
{
  toolName: "sessions_spawn",
  params: { ... },
  error: "error message",   // ← 有值
  // result 不存在
}
```

注意：`sessions_spawn` 内部的 `forbidden` 和 `error` 状态是正常返回值（不抛异常），会被 `jsonResult` 包装后出现在 `event.result.details` 中。只有网络异常等未预期错误才走 `event.error`。

### 2.6 跨 Hook 状态传递

两个 hook 的 event 中**均无 `toolCallId`**。

**ctx 信息不对称：**

| | before_tool_call ctx | after_tool_call ctx |
|---|---|---|
| `toolName` | ✅ | ✅ |
| `sessionKey` | ✅ (`pi-tools.before-tool-call.ts:150`) | ❌ 只传了 `{ toolName }` (`pi-tool-definition-adapter.ts:129`) |
| `agentId` | ✅ (`pi-tools.before-tool-call.ts:149`) | ❌ |

before hook 的 ctx 有 `sessionKey`，但 after hook 的 ctx **没有**，所以不能用 `sessionKey` 做跨 hook 关联。

**解决方案：直接通过 params 传递 taskId。**

`before_tool_call` 可以返回修改后的 params（`pi-tools.before-tool-call.ts:161-165`），修改后的 params 会传递给 tool 执行，也会传递给 `after_tool_call`（`pi-tool-definition-adapter.ts:115-117`）。

利用这个能力，在 before hook 中将 `taskId` 直接注入到 params 的 `_clawteam_taskId` 字段。after hook 从 `event.params._clawteam_taskId` 取出即可，无需任何中间存储。

`taskId` 本身全局唯一，天然并发安全。

### 2.7 并发安全分析

**进程模型：** 所有 main session 和 subagent session 运行在**同一个 Node.js 进程**中。插件加载一次（`loader.ts:334` 使用 `registryCache`），全局 hook runner 是单例（`hook-runner-global.ts:15`）。

**为什么不需要额外的并发处理：** `taskId` 通过 params 注入，每次 tool call 的 params 是独立的对象，不同 session 的 params 互不干扰。不存在共享状态，不存在竞态条件。

**注入额外字段不会影响 sessions_spawn 执行：**
- Schema 使用 `Type.Object()`（typebox），默认不拒绝额外属性
- execute 内部用 `args as Record<string, unknown>` 按名取值，忽略未知字段（`sessions-spawn-tool.ts:42-57`）

---

## 3. sessions_spawn 输入参数

| 参数名 | 类型 | 必需 | 默认值 | 说明 |
|-------|------|------|--------|------|
| `task` | `string` | 是 | - | 任务描述 |
| `label` | `string` | 否 | 无 | 子 session 标签 |
| `agentId` | `string` | 否 | 当前 agent | 指定 agent ID |
| `model` | `string` | 否 | 继承父 session | 模型覆盖 |
| `thinking` | `string` | 否 | 无 | 思考级别：`off`/`low`/`medium`/`high` |
| `runTimeoutSeconds` | `number` | 否 | 无限制 | 超时时间（秒） |
| `thread` | `boolean` | 否 | `false` | 是否绑定线程 |
| `mode` | `"run"\|"session"` | 否 | 自动推断 | 执行模式 |
| `cleanup` | `"delete"\|"keep"` | 否 | `"keep"` | 清理策略 |

## 4. sessions_spawn 返回结果

### 成功

```typescript
{ status: "accepted", childSessionKey: string, runId: string, mode: "run"|"session", note: string, modelApplied?: boolean }
```

### 权限拒绝

```typescript
{ status: "forbidden", error: string }
```

### 错误

```typescript
{ status: "error", error: string, childSessionKey?: string, runId?: string }
```

---

## 5. 插件实现

### 5.1 目录结构

```
~/.openclaw/extensions/clawteam-auto-tracker/
├── openclaw.plugin.json
├── index.ts
├── create-task.ts
└── track-session.ts
```

### 5.2 openclaw.plugin.json

```json
{
  "id": "clawteam-auto-tracker",
  "name": "ClawTeam Auto Tracker",
  "version": "1.0.0",
  "description": "Automatically create ClawTeam tasks and track sessions_spawn calls",
  "configSchema": {
    "type": "object",
    "properties": {
      "enabled": { "type": "boolean", "default": true },
      "apiEndpoint": { "type": "string" },
      "apiKey": { "type": "string" },
      "projectId": { "type": "string" },
      "taskPrefix": { "type": "string", "default": "OPENCLAW" },
      "autoCreateTask": { "type": "boolean", "default": true }
    },
    "required": ["apiEndpoint", "apiKey"]
  }
}
```

### 5.3 create-task.ts — 创建 ClawTeam 任务

```typescript
export interface CreateTaskOptions {
  apiEndpoint: string;
  apiKey: string;
  projectId?: string;
  taskPrefix?: string;
  logger?: any;
}

export interface CreateTaskResult {
  taskId: string;
  taskUrl?: string;
  createdAt: string;
}

export async function createTask(
  params: { title: string; description?: string; metadata?: Record<string, any> },
  options: CreateTaskOptions,
): Promise<CreateTaskResult> {
  const { apiEndpoint, apiKey, projectId, taskPrefix, logger } = options;

  logger?.info(`[ClawTeam] Creating task: ${params.title}`);

  const response = await fetch(`${apiEndpoint}/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      project_id: projectId,
      title: params.title,
      description: params.description,
      type: "automation",
      metadata: { ...params.metadata, source: "openclaw" },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ClawTeam API error: ${response.status} ${text}`);
  }

  const result = await response.json();
  const taskId = taskPrefix ? `${taskPrefix}-${result.id}` : String(result.id);

  logger?.info(`[ClawTeam] Task created: ${taskId}`);
  return { taskId, taskUrl: result.url, createdAt: result.created_at || new Date().toISOString() };
}

/** 从 sessions_spawn 参数中提取任务信息 */
export function extractTaskInfoFromSpawnParams(params: Record<string, unknown>) {
  const task = String(params.task ?? "");
  const label = String(params.label ?? "");
  const agentId = String(params.agentId ?? "");
  const mode = String(params.mode ?? "run");

  return {
    title: label || task.slice(0, 100) || "OpenClaw Spawn Task",
    description: `Task: ${task}\nAgent: ${agentId || "default"}, Mode: ${mode}`,
    metadata: {
      openclaw_task: task,
      openclaw_label: label,
      openclaw_agent_id: agentId,
      openclaw_mode: mode,
    },
  };
}
```

### 5.4 track-session.ts — 追踪 Session

```typescript
export interface TrackSessionOptions {
  apiEndpoint: string;
  apiKey: string;
  logger?: any;
}

export async function trackSession(
  clawteam_taskId: string,
  childSessionKey: string,
  options: TrackSessionOptions,
): Promise<void> {
  const { apiEndpoint, apiKey, logger } = options;

  logger?.info(`[ClawTeam] Tracking: ${clawteam_taskId} → ${childSessionKey}`);

  const response = await fetch(`${apiEndpoint}/tasks/${clawteam_taskId}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      session_key: childSessionKey,
      tracked_at: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ClawTeam API error: ${response.status} ${text}`);
  }

  // 本地备份
  try {
    const fs = await import("fs/promises");
    const path = await import("path");
    const os = await import("os");
    const dir = path.join(os.homedir(), ".openclaw", "clawteam-tracking");
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(
      path.join(dir, "sessions.jsonl"),
      JSON.stringify({ clawteam_taskId, childSessionKey, ts: new Date().toISOString() }) + "\n",
    );
  } catch {
    // 本地日志失败不影响主流程
  }
}
```

### 5.5 index.ts — 主插件逻辑（经校验修正 + 并发安全）

taskId 全局唯一，直接通过 params 注入传递，无需中间存储。

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createTask, extractTaskInfoFromSpawnParams } from "./create-task.js";
import { trackSession } from "./track-session.js";

const TASK_ID_KEY = "_clawteam_taskId";

export default {
  id: "clawteam-auto-tracker",
  name: "ClawTeam Auto Tracker",

  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig ?? {};
    if (config.enabled === false) return;
    if (!config.apiEndpoint || !config.apiKey) {
      api.logger.error("[ClawTeam] Missing required config: apiEndpoint, apiKey");
      return;
    }

    api.logger.info("[ClawTeam] Auto tracker registered");

    // ═══════════════════════════════════════════════════════════════════════
    // Hook 1: before_tool_call（顺序执行，可安全 await）
    // 职责：
    //   1. 调用 create_task() 生成 taskId
    //   2. 将 taskId 注入到 params 中，传递给 after hook
    // ═══════════════════════════════════════════════════════════════════════
    api.on("before_tool_call", async (event, ctx) => {
      if (event.toolName !== "sessions_spawn") return;
      if (config.autoCreateTask === false) return;

      // 如果用户已手动传入 _clawteam_taskId，跳过自动创建
      if ((event.params as any)?.[TASK_ID_KEY]) return;

      try {
        const taskInfo = extractTaskInfoFromSpawnParams(event.params);

        const result = await createTask(taskInfo, {
          apiEndpoint: config.apiEndpoint,
          apiKey: config.apiKey,
          projectId: config.projectId,
          taskPrefix: config.taskPrefix || "OPENCLAW",
          logger: api.logger,
        });

        api.logger.info(`[ClawTeam] Created task: ${result.taskId}`);

        // 将 taskId 注入到 params 中
        // before_tool_call 支持返回 { params } 来修改传递给 tool 和 after hook 的参数
        // 额外字段不影响 sessions_spawn 执行（typebox 默认不拒绝额外属性）
        return {
          params: {
            [TASK_ID_KEY]: result.taskId,
          },
        };
      } catch (err: any) {
        api.logger.error(`[ClawTeam] create_task failed: ${err.message}`);
        // 不阻断 spawn 执行，不注入 taskId（after hook 会因取不到 taskId 而跳过）
      }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Hook 2: after_tool_call（并行执行）
    // 职责：
    //   1. 从 params 中取出 taskId
    //   2. 从 result 中取出 childSessionKey
    //   3. 调用 track_session(taskId, childSessionKey)
    // ═══════════════════════════════════════════════════════════════════════
    api.on("after_tool_call", async (event, ctx) => {
      if (event.toolName !== "sessions_spawn") return;

      // 从 params 中取出 taskId（before hook 注入的）
      const taskId = (event.params as any)?.[TASK_ID_KEY];
      if (!taskId) return; // before hook 未执行或失败，跳过

      // 检查运行时异常（网络错误等未预期异常走这里）
      if (event.error) {
        api.logger.warn(`[ClawTeam] spawn threw error: ${event.error}, skipping`);
        return;
      }

      // ┌─────────────────────────────────────────────────────────────────┐
      // │ 关键：event.result 是 AgentToolResult，真正的数据在 .details 里 │
      // │ 源码：sessions-spawn-tool.ts:90 → jsonResult(result)           │
      // │       common.ts:212 → { content: [...], details: payload }     │
      // └─────────────────────────────────────────────────────────────────┘
      const details = (event.result as any)?.details;

      if (details?.status !== "accepted") {
        api.logger.warn(`[ClawTeam] spawn not accepted (status=${details?.status}), skipping`);
        return;
      }

      const childSessionKey = details?.childSessionKey;
      if (!childSessionKey) {
        api.logger.warn("[ClawTeam] No childSessionKey in result");
        return;
      }

      // 调用 track_session
      try {
        await trackSession(taskId, childSessionKey, {
          apiEndpoint: config.apiEndpoint,
          apiKey: config.apiKey,
          logger: api.logger,
        });

        api.logger.info(`[ClawTeam] Tracked: ${taskId} → ${childSessionKey}`);
      } catch (err: any) {
        api.logger.error(`[ClawTeam] track_session failed: ${err.message}`);
        // 不影响 spawn 结果
      }
    });
  },
};
```

---

## 6. 配置

在 `~/.openclaw/config.json` 中添加：

```json
{
  "plugins": {
    "clawteam-auto-tracker": {
      "enabled": true,
      "apiEndpoint": "https://api.clawteam.com/v1",
      "apiKey": "your-api-key-here",
      "projectId": "project-123",
      "taskPrefix": "OPENCLAW",
      "autoCreateTask": true
    }
  }
}
```

---

## 7. 完整数据流

```
LLM 调用 sessions_spawn({ task: "Analyze code", label: "Security" })
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  before_tool_call hook（顺序执行）                              │
│                                                                 │
│  event.toolName = "sessions_spawn"                              │
│  event.params = { task: "Analyze code", label: "Security" }     │
│                                                                 │
│  ① extractTaskInfoFromSpawnParams(event.params)                 │
│  ② await createTask(taskInfo) → { taskId: "OPENCLAW-12345" }   │
│  ③ return { params: { _clawteam_taskId: "OPENCLAW-12345" } }   │
│     → params 被合并为:                                          │
│     { task: "Analyze code", label: "Security",                  │
│       _clawteam_taskId: "OPENCLAW-12345" }                      │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  sessions_spawn 执行                                            │
│  params = { task: "Analyze code", label: "Security",            │
│             _clawteam_taskId: "OPENCLAW-12345" }                │
│  → _clawteam_taskId 被忽略（typebox 不拒绝额外属性）            │
│  → spawnSubagentDirect(...)                                     │
│  → return jsonResult({                                          │
│      status: "accepted",                                        │
│      childSessionKey: "agent:main:subagent:abc123",             │
│      runId: "run-xyz", mode: "run", note: "..."                 │
│    })                                                           │
│                                                                 │
│  实际返回值 = {                                                  │
│    content: [{ type: "text", text: "{...}" }],                  │
│    details: { status: "accepted", childSessionKey: "...", ... } │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  after_tool_call hook（并行执行）                                │
│                                                                 │
│  event.params = { task: "Analyze code", label: "Security",      │
│                   _clawteam_taskId: "OPENCLAW-12345" }          │
│  event.result = { content: [...], details: { status, ... } }    │
│                                                                 │
│  ① taskId = event.params._clawteam_taskId → "OPENCLAW-12345"   │
│  ② const details = event.result.details                         │
│  ③ details.status === "accepted" ✅                              │
│  ④ details.childSessionKey === "agent:main:subagent:abc123" ✅   │
│  ⑤ await trackSession("OPENCLAW-12345", "agent:...abc123")      │
└─────────────────────────────────────────────────────────────────┘
```

### 7.1 多 session 并发场景

```
Session A: spawn({ task: "Analyze code", label: "Security" })
Session B: spawn({ task: "Analyze code", label: "Security" })  ← 完全相同的参数

┌─ Session A ──────────────────────────────────────────────────────┐
│  before: createTask() → taskId_A = "OPENCLAW-12345"              │
│          return { params: { _clawteam_taskId: "OPENCLAW-12345" }}│
│  spawn:  执行，params 含 taskId_A                                │
│  after:  taskId = params._clawteam_taskId → "OPENCLAW-12345" ✅  │
└──────────────────────────────────────────────────────────────────┘

┌─ Session B ──────────────────────────────────────────────────────┐
│  before: createTask() → taskId_B = "OPENCLAW-12346"              │
│          return { params: { _clawteam_taskId: "OPENCLAW-12346" }}│
│  spawn:  执行，params 含 taskId_B                                │
│  after:  taskId = params._clawteam_taskId → "OPENCLAW-12346" ✅  │
└──────────────────────────────────────────────────────────────────┘

每次 tool call 的 params 是独立对象，无共享状态，天然并发安全 ✅
```

---

## 8. 错误处理

### 场景 1：create_task() 失败

```
before_tool_call → create_task() 抛异常 → 捕获，记录日志 → 不注入 taskId
    ↓
sessions_spawn 正常执行
    ↓
after_tool_call → params 中无 _clawteam_taskId → 跳过 tracking
```

结果：spawn 成功，但没有创建任务，也没有追踪。

### 场景 2：sessions_spawn 失败（forbidden/error）

```
before_tool_call → create_task() 成功 → 注入 taskId 到 params
    ↓
sessions_spawn 返回 { status: "forbidden", error: "..." }
    ↓
after_tool_call → 取出 taskId
  → details.status === "forbidden" → 跳过 tracking
```

结果：任务已创建但 spawn 失败，没有 session 可追踪。

### 场景 3：sessions_spawn 运行时异常

```
before_tool_call → create_task() 成功 → 注入 taskId 到 params
    ↓
sessions_spawn 抛出异常
    ↓
after_tool_call → 取出 taskId
  → event.error 有值 → 跳过 tracking
```

结果：同场景 2。

### 场景 4：track_session() 失败

```
before_tool_call → create_task() 成功 → 注入 taskId 到 params
    ↓
sessions_spawn 成功
    ↓
after_tool_call → 取出 taskId
  → track_session() 抛异常 → 捕获，记录日志
```

结果：spawn 成功，任务已创建，但关联失败。可通过本地日志补救。

---

## 9. 高级扩展

### 9.1 支持手动指定 taskId

用户直接在 spawn params 中传入 `_clawteam_taskId`，before hook 检测到后跳过 `create_task()`：

```typescript
// 用户调用
sessions_spawn({
  task: "Analyze code",
  label: "Security",
  _clawteam_taskId: "OPENCLAW-12345",  // 手动指定，跳过自动创建
})
```

before hook 中的逻辑（已内置在 5.5 的 index.ts 中）：

```typescript
// 如果用户已手动传入 _clawteam_taskId，跳过自动创建
if ((event.params as any)?.[TASK_ID_KEY]) return;
```

不占用 label 字段，无长度限制。

### 9.2 监听 session 结束，更新任务状态

```typescript
api.on("subagent_ended", async (event, ctx) => {
  const taskId = await findTaskIdBySessionKey(event.targetSessionKey);
  if (!taskId) return;

  await updateTaskStatus(taskId, "completed", {
    outcome: event.outcome,
    ended_at: new Date().toISOString(),
  });
});
```

### 9.3 spawn 失败时标记任务

```typescript
// 在 after_tool_call 中
const details = (event.result as any)?.details;

if (details?.status === "accepted") {
  await trackSession(clawteam_taskId, details.childSessionKey, ...);
} else {
  // spawn 失败，标记任务
  await updateTaskStatus(clawteam_taskId, "failed", {
    error: details?.error || event.error,
  });
}
```

---

## 10. 校验总结

| 检查项 | 结果 | 源码依据 |
|-------|------|---------|
| before_tool_call 能拦截 sessions_spawn | ✅ | `pi-tools.before-tool-call.ts:74` → `hookRunner.runBeforeToolCall` |
| before_tool_call 顺序执行，可 await | ✅ | `hooks.ts:424` → `runModifyingHook` → `for...of` |
| after_tool_call 能拦截 sessions_spawn | ✅ | `pi-tool-definition-adapter.ts:119-136`（成功）、`165-182`（异常） |
| before hook 可返回修改后的 params | ✅ | `pi-tools.before-tool-call.ts:161-165`，合并到原 params |
| 修改后的 params 传递给 after hook | ✅ | `pi-tool-definition-adapter.ts:115-117`，`afterParams` 使用修改后的值 |
| 额外字段不影响 sessions_spawn 执行 | ✅ | `sessions-spawn-tool.ts:8` typebox 默认不拒绝额外属性，`:42` 按名取值 |
| 通过 params 传递 taskId 并发安全 | ✅ | 每次 tool call 的 params 是独立对象，无共享状态 |
| event.result 需通过 `.details` 访问 | ✅ | `common.ts:212` → `jsonResult` 包了一层 `{ content, details }` |
| 需检查 `event.error` | ✅ | `pi-tool-definition-adapter.ts:169-174`，异常时 result 为 undefined |
| create_task 失败不阻断 spawn | ✅ | try-catch 捕获，不返回 `{ block: true }`，不注入 taskId |
| track_session 失败不影响结果 | ✅ | try-catch 捕获，after_tool_call 返回值被忽略 |

---

## 11. 已知限制

| 限制 | 影响 | 缓解措施 |
|------|------|---------|
| create_task 在 spawn 前执行 | spawn 失败时任务已创建 | 通过 9.3 标记失败状态 |
| 依赖外部 API | API 不可用时无法创建/追踪 | 本地 JSONL 日志备份 |
| 不能替换 `sessions_spawn` 工具名 | `tools.ts:112` 禁止同名注册 | 只能用 Hook 方式扩展 |
| params 中注入了 `_clawteam_taskId` 字段 | LLM 返回的 tool result 中可能包含该字段 | 使用下划线前缀避免语义冲突，sessions_spawn 忽略未知字段 |

---

## 当前实现状态（2026-02-25）

### 插件位置

插件已从 `~/.openclaw/extensions/` 迁移到项目仓库：

```
packages/openclaw-plugin/
├── index.ts                  # 插件主逻辑
├── task_system_prompt_executor.md  # executor 角色上下文模板
├── task_system_prompt_sender.md    # sender 角色上下文模板
├── openclaw.plugin.json      # 插件清单
└── package.json              # openclaw.extensions 配置
```

安装方式（软链接，开发模式）：

```bash
openclaw plugins install --link packages/openclaw-plugin
```

`~/.openclaw/openclaw.json` 需配置：

```json
{ "plugins": { "allow": ["clawteam-auto-tracker"] } }
```

### sessions_spawn 参数

| 参数 | 说明 |
|------|------|
| `_clawteam_role` | `"executor"` 或 `"sender"` |
| `_clawteam_taskId` | executor 必填；sender 可选（插件自动创建） |
| `_clawteam_from_bot_id` | 非 sender 角色必填（委托方 bot ID）；缺失时插件阻断 spawn |

### 角色模板注入机制

插件在 `register` 时按角色读取 `task_system_prompt_executor.md` 和 `task_system_prompt_sender.md` 模板（失败则静默跳过）。在 `before_tool_call` 中根据检测到的角色选择对应模板，渲染后前置到 `task` 参数：

```
{{TASK_ID}}       → ClawTeam 任务 ID
{{ROLE}}          → 当前角色（executor / sender）
{{GATEWAY_URL}}   → Gateway 地址
{{FROM_BOT_ID}}   → 委托方 bot ID
```

模板末尾以 `=== TASK CONTENT BEGINS BELOW ===` 分隔，之后是原始 task 内容。

### tool_result_persist Hook

在 sessions_spawn 结果返回给主 session LLM 之前，追加：

```
[ClawTeam] taskId: <taskId>
```

跨 hook 状态通过模块级 `pendingTaskId` 变量传递（`before_tool_call` 设置，`tool_result_persist` 消费后清空）。

### 安装命令

```bash
# 安装插件（软链接，修改即时生效）
openclaw plugins install --link packages/openclaw-plugin

# scripts/start-local.sh 已集成此命令，启动时自动执行
```

---

## 12. 参考源码

| 文件 | 作用 |
|------|------|
| `src/agents/tools/sessions-spawn-tool.ts` | sessions_spawn 工具定义 |
| `src/agents/subagent-spawn.ts` | spawn 核心实现 |
| `src/agents/pi-tool-definition-adapter.ts` | tool adapter，hook 调用入口 |
| `src/agents/pi-tools.before-tool-call.ts` | before_tool_call 调用逻辑 |
| `src/plugins/hooks.ts` | hook runner 实现 |
| `src/plugins/types.ts` | hook event/ctx 类型定义 |
| `src/agents/tools/common.ts:212` | `jsonResult` 返回结构 |
