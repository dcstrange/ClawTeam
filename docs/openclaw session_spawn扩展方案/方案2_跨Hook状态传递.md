# 方案 2：before_tool_call + after_tool_call 跨 Hook 状态传递

> ⚠️ Historical Notice: 本目录为历史方案调研，不代表当前线上实现。
> 当前实现请参考：`docs/Gateway/GATEWAY_TASK_MANAGEMENT.md`、`docs/Gateway/消息构建器.md`、`docs/task-operations/README.md`。

## 适用场景

需要在 spawn **之前**做同步预处理（如验证 taskId 是否合法），同时在 spawn **之后**拿到 childSessionKey 完成追踪。

## 关键约束（源码验证）

查看 `src/plugins/types.ts:479-496`，两个 hook 的 event 中**均不含 `toolCallId`**：

```typescript
// before_tool_call event
export type PluginHookBeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  // ❌ 没有 toolCallId
};

// after_tool_call event
export type PluginHookAfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
  // ❌ 没有 toolCallId
};
```

**因此跨 Hook 共享状态必须用 `params` 指纹作 key，而非 `toolCallId`。**

## 数据流

```
before_tool_call
  → 提取 taskId（可同时做前置验证）
  → Map.set(paramsFingerprint, taskId)
      ↓
sessions_spawn 执行
      ↓
after_tool_call
  → Map.get(paramsFingerprint) → taskId
  → track_session(taskId, childSessionKey)
  → Map.delete(paramsFingerprint)
```

## 目录结构

```
~/.openclaw/extensions/clawteam-session-tracker/
├── openclaw.plugin.json
├── index.ts
└── stash.ts          ← 跨 Hook 共享状态
```

## stash.ts

```typescript
// 用参数指纹在 before/after 两个 hook 之间共享状态。
// 风险：极低概率下两个并发调用参数完全相同时会冲突。
// 缓解：5 分钟 TTL 自动清理，避免内存泄漏。

interface PendingEntry {
  clawteam_taskId: string;
  insertedAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const store = new Map<string, PendingEntry>();

// 定时清理超时条目
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now - entry.insertedAt > TTL_MS) {
      store.delete(key);
    }
  }
}, 60_000).unref(); // .unref() 避免阻止进程退出

export function makeKey(params: Record<string, unknown>): string {
  // 使用 task + label 组合作为指纹
  // task 截取前 120 字符，label 完整使用
  const task = String(params.task ?? "").slice(0, 120);
  const label = String(params.label ?? "");
  return `${task}::${label}`;
}

export function stash(params: Record<string, unknown>, taskId: string): void {
  store.set(makeKey(params), { clawteam_taskId: taskId, insertedAt: Date.now() });
}

export function pop(params: Record<string, unknown>): string | undefined {
  const key = makeKey(params);
  const entry = store.get(key);
  if (!entry) return undefined;
  store.delete(key);
  return entry.clawteam_taskId;
}
```

## index.ts

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stash, pop } from "./stash.js";
import { trackSession } from "./tracker.js";

const TASK_ID_RE = /\[TASK:([^\]]+)\]/;

export default {
  id: "clawteam-session-tracker",
  name: "ClawTeam Session Tracker",

  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig ?? {};
    if (config.enabled === false) return;

    // ── Hook 1: before_tool_call ──────────────────────────────────────────
    // 职责：提取 taskId 并暂存；可在此做同步前置验证。
    api.on("before_tool_call", async (event, ctx) => {
      if (event.toolName !== "sessions_spawn") return;

      const label = event.params?.label;
      if (typeof label !== "string") return;

      const match = label.match(TASK_ID_RE);
      if (!match) return;

      const taskId = match[1].trim();

      // 可选：前置验证 taskId 是否合法
      if (config.validateEndpoint) {
        const valid = await checkTaskExists(taskId, config);
        if (!valid) {
          api.logger.warn(`[ClawTeam] taskId "${taskId}" 不存在，将跳过追踪`);
          return; // 不阻断 spawn，只是不追踪
        }
      }

      stash(event.params, taskId);
      api.logger.debug(`[ClawTeam] stashed taskId="${taskId}"`);
    });

    // ── Hook 2: after_tool_call ───────────────────────────────────────────
    // 职责：取出暂存的 taskId，拿到 childSessionKey 后调用 track_session。
    api.on("after_tool_call", async (event, ctx) => {
      if (event.toolName !== "sessions_spawn") return;

      // 先取出 taskId（不管 spawn 是否成功都要清理 stash）
      const taskId = pop(event.params);
      if (!taskId) return;

      if ((event.result as any)?.status !== "accepted") {
        api.logger.debug(`[ClawTeam] spawn 未成功（status=${(event.result as any)?.status}），跳过追踪`);
        return;
      }

      const childSessionKey = (event.result as any)?.childSessionKey;
      if (!childSessionKey) return;

      try {
        api.logger.info(`[ClawTeam] track_session("${taskId}", "${childSessionKey}")`);
        await trackSession(taskId, childSessionKey, {
          apiEndpoint: config.apiEndpoint,
          apiKey: config.apiKey,
          logger: api.logger,
        });
      } catch (err: any) {
        api.logger.error(`[ClawTeam] track_session 失败: ${err.message}`);
      }
    });
  },
};

async function checkTaskExists(taskId: string, config: any): Promise<boolean> {
  try {
    const res = await fetch(`${config.validateEndpoint}/${taskId}`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    return res.ok;
  } catch {
    return true; // 验证接口挂了，放行
  }
}
```

## 优缺点

**优点：**
- ✅ before_tool_call 可做前置验证，不合法时可阻断
- ✅ 职责分离：提取与追踪解耦
- ✅ 不修改源码

**缺点：**
- ⚠️ 依赖 params 指纹作为跨 Hook key，极低概率并发冲突
- ⚠️ taskId 仍需通过 label/task 编码传入
