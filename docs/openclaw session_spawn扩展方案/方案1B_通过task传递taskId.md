# 方案 1B：通过 task 内容传递 taskId

> ⚠️ Historical Notice: 本目录为历史方案调研，不代表当前线上实现。
> 当前实现请参考：`docs/Gateway/GATEWAY_TASK_MANAGEMENT.md`、`docs/Gateway/消息构建器.md`、`docs/task-operations/README.md`。

## 实现思路

在 `task` 参数中嵌入 `clawteam_taskId`，使用特殊标记（如 `[CLAWTEAM_TASK_ID:xxx]`），在 hook 中解析并移除标记后再传递给实际的 task。

## 优点

✅ 不占用 label 字段
✅ 对用户更透明
✅ 可以在 task 中自然嵌入

## 缺点

⚠️ 需要修改 task 内容
⚠️ 可能影响 LLM 理解

## 插件实现

### index.ts

```typescript
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { trackSession } from './tracker.js';

export default {
  id: "clawteam-session-tracker",
  name: "ClawTeam Session Tracker",

  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig || {};
    const enabled = config.enabled !== false;

    if (!enabled) {
      return;
    }

    // 匹配 [CLAWTEAM_TASK_ID:xxx] 格式
    const taskIdPattern = /\[CLAWTEAM_TASK_ID:([^\]]+)\]/;

    api.logger.info('[ClawTeam] Session tracker registered (task-based)');

    api.on("after_tool_call", async (event, ctx) => {
      if (event.toolName !== "sessions_spawn") {
        return;
      }

      if (event.result?.status !== "accepted") {
        return;
      }

      const task = event.params?.task;
      if (!task || typeof task !== 'string') {
        return;
      }

      const match = task.match(taskIdPattern);
      if (!match) {
        return;
      }

      const clawteam_taskId = match[1].trim();
      const childSessionKey = event.result.childSessionKey;

      if (!childSessionKey) {
        return;
      }

      try {
        api.logger.info(`[ClawTeam] Tracking session: taskId=${clawteam_taskId}, sessionKey=${childSessionKey}`);

        await trackSession(clawteam_taskId, childSessionKey, {
          apiEndpoint: config.apiEndpoint,
          apiKey: config.apiKey,
          logger: api.logger,
          metadata: {
            runId: event.result.runId,
            mode: event.result.mode,
            agentId: ctx.agentId,
            parentSessionKey: ctx.sessionKey,
            // 移除标记后的原始 task
            originalTask: task.replace(taskIdPattern, '').trim(),
            timestamp: new Date().toISOString()
          }
        });

        api.logger.info(`[ClawTeam] Successfully tracked session ${childSessionKey}`);
      } catch (error) {
        api.logger.error(`[ClawTeam] Failed to track session: ${error.message}`);
      }
    });
  }
};
```

## 使用方式

```typescript
const result = await sessions_spawn({
  task: "[CLAWTEAM_TASK_ID:CLAWTEAM-12345] Analyze the codebase for security vulnerabilities",
  label: "Security Analysis",
  thread: true,
  mode: "session"
});
```

## 辅助函数

```typescript
export function createTaskWithId(taskId: string, task: string): string {
  return `[CLAWTEAM_TASK_ID:${taskId}] ${task}`;
}

// 使用
const result = await sessions_spawn({
  task: createTaskWithId("CLAWTEAM-12345", "Analyze the codebase for security vulnerabilities"),
  label: "Security Analysis",
  thread: true,
  mode: "session"
});
```
