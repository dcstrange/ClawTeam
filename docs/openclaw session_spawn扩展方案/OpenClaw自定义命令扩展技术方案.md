# OpenClaw 自定义命令扩展技术方案

> ⚠️ Historical Notice: 本目录为历史方案调研，不代表当前线上实现。
> 当前实现请参考：`docs/Gateway/GATEWAY_TASK_MANAGEMENT.md`、`docs/Gateway/消息构建器.md`、`docs/task-operations/README.md`。

## 概述

OpenClaw 提供了完整的插件系统和 Hook 机制，允许在不修改源代码的情况下扩展功能、拦截 tool call 并追加自定义逻辑。

**重要发现：sessions_spawn tool 完全支持 Hook 拦截**

经过源码验证（`src/agents/pi-tool-definition-adapter.ts:99-138`），所有通过 `createOpenClawTools` 创建的工具（包括 `sessions_spawn`）都会经过统一的 tool adapter 层，该层实现了完整的 Hook 机制：

- ✅ `sessions_spawn` 可以被 `before_tool_call` hook 拦截（修改参数或阻止执行）
- ✅ `sessions_spawn` 可以被 `after_tool_call` hook 拦截（触发额外操作）
- ✅ `sessions_spawn` 可以被 `tool_result_persist` hook 拦截（修改返回结果）

这意味着你可以在 spawn session 前后插入任何自定义逻辑，无需修改源代码。

## 核心架构

### 1. Hook 系统

OpenClaw 提供 22 种 lifecycle hooks，其中与 tool call 相关的关键 hooks：

| Hook 名称 | 触发时机 | 执行模式 | 主要用途 |
|----------|---------|---------|---------|
| `before_tool_call` | Tool 调用前 | 异步 | 修改参数、阻止执行、权限检查 |
| `after_tool_call` | Tool 调用后 | 异步并行 | 日志记录、触发额外操作、通知 |
| `tool_result_persist` | 结果持久化前 | 同步 | 修改返回结果、数据转换 |

### 2. Tool Call 执行流程

```
用户请求
    ↓
before_tool_call hook (可修改参数/阻止执行)
    ↓
执行实际 tool
    ↓
after_tool_call hook (并行执行，不阻塞返回)
    ↓
tool_result_persist hook (同步，可修改结果)
    ↓
返回结果
```

### 3. 插件加载优先级

1. **Bundled plugins** - 内置插件 (`openclaw_src/extensions/`)
2. **Global plugins** - 全局插件 (`~/.openclaw/extensions/`)
3. **Workspace plugins** - 工作区插件 (`<workspace>/extensions/`)
4. **Config plugins** - 配置文件指定的插件

## 插件开发指南

### 基本结构

每个插件必须包含以下文件：

```
my-plugin/
├── openclaw.plugin.json    # 插件清单（必需）
├── index.ts                # 入口文件（必需）
├── package.json            # npm 包信息（可选）
└── README.md               # 文档（推荐）
```

### 插件清单示例

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Plugin description",
  "configSchema": {
    "type": "object",
    "properties": {
      "enabled": {
        "type": "boolean",
        "default": true
      },
      "customOption": {
        "type": "string",
        "default": "value"
      }
    }
  }
}
```

### 插件入口文件模板

```typescript
export default {
  id: "my-plugin",
  name: "My Plugin",

  register(api) {
    // 注册 hooks
    api.on("after_tool_call", async (event, ctx) => {
      // event: { toolName, params, result, error, durationMs }
      // ctx: { agentId, sessionKey, toolName }

      // 实现你的逻辑
    }, { priority: 100 });

    // 可以注册多个 hooks
    api.on("before_tool_call", async (event, ctx) => {
      // 前置处理
    });
  },

  // 可选：插件卸载时的清理逻辑
  unregister(api) {
    // 清理资源
  }
};
```

## 实践案例

### 案例 1：拦截 sessions_spawn 并记录日志

**需求**：每次执行 sessions_spawn tool 时，自动记录到日志文件。

```typescript
// ~/.openclaw/extensions/sessions-spawn-logger/index.ts
import fs from 'fs/promises';
import path from 'path';

export default {
  id: "sessions-spawn-logger",
  name: "Sessions Spawn Logger",

  register(api) {
    const logFile = path.join(process.env.HOME, '.openclaw', 'sessions-spawn-log.jsonl');

    api.on("after_tool_call", async (event, ctx) => {
      if (event.toolName === "sessions_spawn") {
        const logEntry = {
          timestamp: new Date().toISOString(),
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          params: {
            task: event.params?.task,
            label: event.params?.label,
            agentId: event.params?.agentId,
            mode: event.params?.mode,
            thread: event.params?.thread
          },
          result: {
            status: event.result?.status,
            childSessionKey: event.result?.childSessionKey,
            runId: event.result?.runId,
            mode: event.result?.mode
          },
          durationMs: event.durationMs,
          success: !event.error
        };

        await fs.appendFile(
          logFile,
          JSON.stringify(logEntry) + '\n',
          'utf-8'
        );

        console.log(`[Sessions Spawn Logger] Logged sessions_spawn call: ${event.result?.childSessionKey}`);
      }
    });
  }
};
```

**openclaw.plugin.json**：
```json
{
  "id": "sessions-spawn-logger",
  "configSchema": {
    "type": "object",
    "properties": {
      "logPath": {
        "type": "string",
        "description": "Custom log file path"
      }
    }
  }
}
```

### 案例 2：sessions_spawn 前验证权限

**需求**：在 spawn session 前检查用户权限，阻止未授权的 spawn 操作。

```typescript
// extensions/sessions-spawn-guard/index.ts
export default {
  id: "sessions-spawn-guard",
  name: "Sessions Spawn Guard",

  register(api) {
    const config = api.getConfig();
    const allowedAgents = config.allowedAgents || ['*'];

    api.on("before_tool_call", async (event, ctx) => {
      if (event.toolName === "sessions_spawn") {
        const requestedAgentId = event.params?.agentId;
        const currentAgentId = ctx.agentId;

        // 检查是否允许 spawn 到指定 agent
        if (requestedAgentId && !allowedAgents.includes('*')) {
          if (!allowedAgents.includes(requestedAgentId)) {
            console.error(`[Spawn Guard] Blocked spawn to unauthorized agent: ${requestedAgentId}`);
            throw new Error(`Unauthorized: Cannot spawn to agent "${requestedAgentId}"`);
          }
        }

        // 检查 spawn 深度限制
        const maxDepth = config.maxSpawnDepth || 3;
        const currentDepth = ctx.spawnDepth || 0;

        if (currentDepth >= maxDepth) {
          console.error(`[Spawn Guard] Blocked spawn: max depth ${maxDepth} reached`);
          throw new Error(`Max spawn depth (${maxDepth}) exceeded`);
        }

        // 检查并发限制
        const maxConcurrent = config.maxConcurrentSessions || 10;
        const activeSessions = await getActiveSessionCount();

        if (activeSessions >= maxConcurrent) {
          console.error(`[Spawn Guard] Blocked spawn: max concurrent sessions ${maxConcurrent} reached`);
          throw new Error(`Max concurrent sessions (${maxConcurrent}) exceeded`);
        }

        console.log(`[Spawn Guard] Authorized sessions_spawn: ${event.params?.task?.substring(0, 50)}...`);
      }
    });
  }
};

async function getActiveSessionCount() {
  // 实现获取活跃 session 数量的逻辑
  // 可以通过 gateway API 或内部状态获取
  return 0;
}
```

### 案例 3：sessions_spawn 后自动触发监控

**需求**：当 spawn 一个新 session 后，自动启动监控和健康检查。

```typescript
// extensions/sessions-spawn-monitor/index.ts
export default {
  id: "sessions-spawn-monitor",
  name: "Sessions Spawn Monitor",

  register(api) {
    const monitors = new Map();

    api.on("after_tool_call", async (event, ctx) => {
      if (event.toolName === "sessions_spawn" && event.result?.status === "accepted") {
        const childSessionKey = event.result.childSessionKey;
        const runId = event.result.runId;

        console.log(`[Monitor] Starting monitoring for session: ${childSessionKey}`);

        // 启动健康检查
        const monitor = startHealthCheck({
          sessionKey: childSessionKey,
          runId,
          task: event.params?.task,
          mode: event.result.mode,
          onTimeout: () => {
            console.warn(`[Monitor] Session ${childSessionKey} timeout detected`);
            // 发送告警通知
            sendAlert({
              type: 'timeout',
              sessionKey: childSessionKey,
              task: event.params?.task
            });
          },
          onError: (error) => {
            console.error(`[Monitor] Session ${childSessionKey} error:`, error);
            // 发送错误通知
            sendAlert({
              type: 'error',
              sessionKey: childSessionKey,
              error: error.message
            });
          }
        });

        monitors.set(childSessionKey, monitor);
      }
    });

    // 监听 session 结束事件
    api.on("session_end", async (event, ctx) => {
      const monitor = monitors.get(ctx.sessionKey);
      if (monitor) {
        monitor.stop();
        monitors.delete(ctx.sessionKey);
        console.log(`[Monitor] Stopped monitoring for session: ${ctx.sessionKey}`);
      }
    });
  }
};

function startHealthCheck({ sessionKey, runId, task, mode, onTimeout, onError }) {
  const startTime = Date.now();
  const timeoutMs = 300000; // 5 分钟超时

  const interval = setInterval(async () => {
    try {
      // 检查 session 状态
      const elapsed = Date.now() - startTime;

      if (elapsed > timeoutMs) {
        onTimeout();
        clearInterval(interval);
        return;
      }

      // 可以通过 gateway API 检查 session 健康状态
      console.log(`[Monitor] Health check for ${sessionKey}: ${elapsed}ms elapsed`);

    } catch (error) {
      onError(error);
      clearInterval(interval);
    }
  }, 30000); // 每 30 秒检查一次

  return {
    stop: () => clearInterval(interval)
  };
}

async function sendAlert(alert) {
  // 实现告警逻辑（Slack、钉钉、邮件等）
  console.log('[Monitor] Alert:', JSON.stringify(alert, null, 2));
}
```

### 案例 4：sessions_spawn 参数自动增强

**需求**：自动为 sessions_spawn 添加默认参数或修改参数。

```typescript
// extensions/sessions-spawn-enhancer/index.ts
export default {
  id: "sessions-spawn-enhancer",
  name: "Sessions Spawn Enhancer",

  register(api) {
    const config = api.getConfig();

    api.on("before_tool_call", async (event, ctx) => {
      if (event.toolName === "sessions_spawn") {
        // 自动添加 label（如果没有提供）
        if (!event.params?.label) {
          const timestamp = new Date().toISOString().substring(0, 19).replace('T', ' ');
          event.params.label = `Auto-spawned at ${timestamp}`;
        }

        // 自动设置超时时间
        if (!event.params?.runTimeoutSeconds) {
          event.params.runTimeoutSeconds = config.defaultTimeout || 600; // 默认 10 分钟
        }

        // 根据任务类型自动选择 mode
        const task = event.params?.task || '';
        if (!event.params?.mode) {
          // 如果任务包含 "monitor"、"watch" 等关键词，使用 session 模式
          if (/monitor|watch|listen|serve/i.test(task)) {
            event.params.mode = 'session';
            event.params.thread = true;
            console.log('[Enhancer] Auto-set mode=session for long-running task');
          } else {
            event.params.mode = 'run';
            console.log('[Enhancer] Auto-set mode=run for one-shot task');
          }
        }

        // 自动添加清理策略
        if (!event.params?.cleanup && event.params?.mode === 'run') {
          event.params.cleanup = 'delete'; // 一次性任务自动清理
          console.log('[Enhancer] Auto-set cleanup=delete for run mode');
        }

        console.log('[Enhancer] Enhanced sessions_spawn params:', event.params);
      }
    });
  }
};
```

### 案例 5：sessions_spawn 结果转换

**需求**：修改 sessions_spawn 的返回结果，添加额外信息。

```typescript
// extensions/sessions-spawn-result-transformer/index.ts
export default {
  id: "sessions-spawn-result-transformer",
  name: "Sessions Spawn Result Transformer",

  register(api) {
    api.on("tool_result_persist", (event, ctx) => {
      if (event.toolName === "sessions_spawn") {
        const result = event.result;

        // 添加额外的元数据
        const enhancedResult = {
          ...result,
          metadata: {
            spawnedAt: new Date().toISOString(),
            parentSessionKey: ctx.sessionKey,
            parentAgentId: ctx.agentId,
            estimatedCost: calculateEstimatedCost(event.params),
            dashboardUrl: `https://dashboard.example.com/sessions/${result.childSessionKey}`
          }
        };

        // 修改返回消息
        return {
          message: {
            ...event.message,
            content: JSON.stringify(enhancedResult, null, 2)
          }
        };
      }
    });
  }
};

function calculateEstimatedCost(params) {
  // 根据参数估算成本
  const baselineCost = 0.01;
  const timeoutMultiplier = (params?.runTimeoutSeconds || 600) / 600;
  return (baselineCost * timeoutMultiplier).toFixed(4);
}
```

### 案例 6：sessions_spawn 与外部系统集成

**需求**：当 spawn session 时，自动在外部项目管理系统（如 Jira）创建任务。

```typescript
// extensions/sessions-spawn-jira-integration/index.ts
export default {
  id: "sessions-spawn-jira-integration",
  name: "Sessions Spawn Jira Integration",

  register(api) {
    const config = api.getConfig();
    const jiraConfig = config.jira || {};

    api.on("after_tool_call", async (event, ctx) => {
      if (event.toolName === "sessions_spawn" && event.result?.status === "accepted") {
        const task = event.params?.task || '';
        const childSessionKey = event.result.childSessionKey;
        const runId = event.result.runId;

        // 在 Jira 创建任务
        try {
          const jiraIssue = await createJiraIssue({
            project: jiraConfig.project || 'OPENCLAW',
            summary: `[OpenClaw] ${event.params?.label || 'Spawned Session'}`,
            description: `
              Task: ${task}

              Session Key: ${childSessionKey}
              Run ID: ${runId}
              Mode: ${event.result.mode}
              Spawned At: ${new Date().toISOString()}

              Parent Session: ${ctx.sessionKey}
              Parent Agent: ${ctx.agentId}
            `,
            issueType: 'Task',
            labels: ['openclaw', 'auto-spawned']
          });

          console.log(`[Jira] Created issue ${jiraIssue.key} for session ${childSessionKey}`);

          // 存储映射关系
          await storeSessionJiraMapping(childSessionKey, jiraIssue.key);

        } catch (error) {
          console.error('[Jira] Failed to create issue:', error);
        }
      }
    });

    // 监听 session 结束，更新 Jira 任务状态
    api.on("session_end", async (event, ctx) => {
      try {
        const jiraKey = await getJiraKeyForSession(ctx.sessionKey);
        if (jiraKey) {
          await updateJiraIssue(jiraKey, {
            status: 'Done',
            resolution: 'Completed',
            comment: `Session completed at ${new Date().toISOString()}`
          });
          console.log(`[Jira] Updated issue ${jiraKey} to Done`);
        }
      } catch (error) {
        console.error('[Jira] Failed to update issue:', error);
      }
    });
  }
};

async function createJiraIssue({ project, summary, description, issueType, labels }) {
  // 实现 Jira API 调用
  const response = await fetch('https://your-domain.atlassian.net/rest/api/3/issue', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from('email:api_token').toString('base64')}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields: {
        project: { key: project },
        summary,
        description: {
          type: 'doc',
          version: 1,
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: description }]
          }]
        },
        issuetype: { name: issueType },
        labels
      }
    })
  });

  return await response.json();
}

async function updateJiraIssue(issueKey, updates) {
  // 实现 Jira 更新逻辑
}

async function storeSessionJiraMapping(sessionKey, jiraKey) {
  // 存储映射关系（可以用文件、数据库等）
}

async function getJiraKeyForSession(sessionKey) {
  // 获取映射关系
  return null;
}
```

### 案例 7：拦截 Task tool 并记录日志

**需求**：每次执行 Task tool 时，自动记录到日志文件。

```typescript
// ~/.openclaw/extensions/spawn-logger/index.ts
import fs from 'fs/promises';
import path from 'path';

export default {
  id: "spawn-logger",
  name: "Spawn Logger",

  register(api) {
    const logFile = path.join(process.env.HOME, '.openclaw', 'spawn-log.jsonl');

    api.on("after_tool_call", async (event, ctx) => {
      if (event.toolName === "Task" || event.toolName === "spawn") {
        const logEntry = {
          timestamp: new Date().toISOString(),
          agentId: ctx.agentId,
          toolName: event.toolName,
          params: event.params,
          durationMs: event.durationMs,
          success: !event.error
        };

        await fs.appendFile(
          logFile,
          JSON.stringify(logEntry) + '\n',
          'utf-8'
        );

        console.log(`[Spawn Logger] Logged ${event.toolName} call`);
      }
    });
  }
};
```

**openclaw.plugin.json**：
```json
{
  "id": "spawn-logger",
  "configSchema": {
    "type": "object",
    "properties": {
      "logPath": {
        "type": "string",
        "description": "Custom log file path"
      }
    }
  }
}
```

### 案例 2：spawn 后自动触发代码审查

**需求**：当 spawn 一个新的 agent 后，自动触发代码审查工具。

```typescript
// extensions/spawn-code-review/index.ts
export default {
  id: "spawn-code-review",
  name: "Spawn Code Review",

  register(api) {
    api.on("after_tool_call", async (event, ctx) => {
      if (event.toolName === "Task" && event.params?.subagent_type === "general-purpose") {
        // 检查是否涉及代码修改
        const description = event.params?.description || "";
        const isCodeTask = /write|edit|modify|implement|fix/i.test(description);

        if (isCodeTask) {
          console.log("[Code Review] Triggering review for spawned task");

          // 触发代码审查逻辑
          await triggerCodeReview({
            agentId: ctx.agentId,
            taskDescription: description,
            timestamp: new Date().toISOString()
          });
        }
      }
    });
  }
};

async function triggerCodeReview(context) {
  // 实现代码审查逻辑
  // 例如：调用 linter、静态分析工具、或发送通知
  console.log(`[Code Review] Reviewing task: ${context.taskDescription}`);

  // 示例：执行 eslint
  const { exec } = require('child_process');
  exec('npm run lint', (error, stdout, stderr) => {
    if (error) {
      console.error(`[Code Review] Lint failed: ${error.message}`);
      return;
    }
    console.log(`[Code Review] Lint passed`);
  });
}
```

### 案例 3：Tool 调用统计和性能监控

**需求**：统计所有 tool 的调用次数和执行时间，生成性能报告。

```typescript
// extensions/tool-metrics/index.ts
export default {
  id: "tool-metrics",
  name: "Tool Metrics",

  register(api) {
    const metrics = new Map();

    // 收集指标
    api.on("after_tool_call", async (event, ctx) => {
      const key = event.toolName;

      if (!metrics.has(key)) {
        metrics.set(key, {
          count: 0,
          totalDuration: 0,
          errors: 0,
          avgDuration: 0
        });
      }

      const stat = metrics.get(key);
      stat.count++;
      stat.totalDuration += event.durationMs || 0;
      stat.avgDuration = stat.totalDuration / stat.count;

      if (event.error) {
        stat.errors++;
      }

      // 每 10 次调用输出一次统计
      if (stat.count % 10 === 0) {
        console.log(`[Metrics] ${key}: ${stat.count} calls, avg ${stat.avgDuration.toFixed(2)}ms`);
      }
    });

    // 会话结束时生成报告
    api.on("session_end", async (event, ctx) => {
      console.log("\n=== Tool Metrics Report ===");

      const sorted = Array.from(metrics.entries())
        .sort((a, b) => b[1].count - a[1].count);

      for (const [tool, stat] of sorted) {
        console.log(`${tool}:`);
        console.log(`  Calls: ${stat.count}`);
        console.log(`  Avg Duration: ${stat.avgDuration.toFixed(2)}ms`);
        console.log(`  Errors: ${stat.errors}`);
        console.log(`  Success Rate: ${((1 - stat.errors / stat.count) * 100).toFixed(1)}%`);
      }
    });
  }
};
```

### 案例 4：参数验证和安全检查

**需求**：在 tool 执行前验证参数，阻止危险操作。

```typescript
// extensions/security-guard/index.ts
export default {
  id: "security-guard",
  name: "Security Guard",

  register(api) {
    api.on("before_tool_call", async (event, ctx) => {
      // 检查 Bash 命令
      if (event.toolName === "Bash") {
        const command = event.params?.command || "";

        // 危险命令黑名单
        const dangerousPatterns = [
          /rm\s+-rf\s+\//,           // rm -rf /
          /:\(\)\{\s*:\|:&\s*\};:/,  // fork bomb
          />\s*\/dev\/sda/,          // 写入磁盘
          /dd\s+if=/,                // dd 命令
        ];

        for (const pattern of dangerousPatterns) {
          if (pattern.test(command)) {
            console.error(`[Security] Blocked dangerous command: ${command}`);
            throw new Error(`Security violation: dangerous command detected`);
          }
        }
      }

      // 检查文件写入路径
      if (event.toolName === "Write" || event.toolName === "Edit") {
        const filePath = event.params?.file_path || "";

        // 禁止写入系统目录
        const forbiddenPaths = ['/etc/', '/usr/', '/bin/', '/sbin/'];

        if (forbiddenPaths.some(p => filePath.startsWith(p))) {
          console.error(`[Security] Blocked write to system path: ${filePath}`);
          throw new Error(`Security violation: cannot write to system directory`);
        }
      }
    });
  }
};
```

### 案例 5：自动备份和版本控制

**需求**：在文件修改前自动创建备份。

```typescript
// extensions/auto-backup/index.ts
import fs from 'fs/promises';
import path from 'path';

export default {
  id: "auto-backup",
  name: "Auto Backup",

  register(api) {
    api.on("before_tool_call", async (event, ctx) => {
      if (event.toolName === "Edit" || event.toolName === "Write") {
        const filePath = event.params?.file_path;

        if (!filePath) return;

        try {
          // 检查文件是否存在
          await fs.access(filePath);

          // 创建备份
          const backupDir = path.join(path.dirname(filePath), '.openclaw-backups');
          await fs.mkdir(backupDir, { recursive: true });

          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const backupPath = path.join(
            backupDir,
            `${path.basename(filePath)}.${timestamp}.bak`
          );

          await fs.copyFile(filePath, backupPath);
          console.log(`[Backup] Created backup: ${backupPath}`);

        } catch (error) {
          // 文件不存在，无需备份
        }
      }
    });
  }
};
```

### 案例 6：集成外部通知系统

**需求**：当特定 tool 执行完成时，发送通知到 Slack/钉钉/飞书。

```typescript
// extensions/notification-hub/index.ts
export default {
  id: "notification-hub",
  name: "Notification Hub",

  register(api) {
    const config = api.getConfig();
    const webhookUrl = config.webhookUrl;

    api.on("after_tool_call", async (event, ctx) => {
      // 只通知长时间运行的任务
      if (event.durationMs > 30000) { // 超过 30 秒
        await sendNotification({
          title: `Tool ${event.toolName} completed`,
          message: `Duration: ${(event.durationMs / 1000).toFixed(1)}s`,
          success: !event.error,
          webhookUrl
        });
      }

      // 通知错误
      if (event.error) {
        await sendNotification({
          title: `Tool ${event.toolName} failed`,
          message: event.error.message,
          success: false,
          webhookUrl
        });
      }
    });
  }
};

async function sendNotification({ title, message, success, webhookUrl }) {
  if (!webhookUrl) return;

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg_type: "text",
        content: {
          text: `${success ? '✅' : '❌'} ${title}\n${message}`
        }
      })
    });

    if (!response.ok) {
      console.error('[Notification] Failed to send notification');
    }
  } catch (error) {
    console.error('[Notification] Error:', error.message);
  }
}
```

**配置文件** (`~/.openclaw/config.json`)：
```json
{
  "plugins": {
    "notification-hub": {
      "enabled": true,
      "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/YOUR_WEBHOOK_TOKEN"
    }
  }
}
```

## 插件安装和管理

### 全局插件安装

```bash
# 创建插件目录
mkdir -p ~/.openclaw/extensions/my-plugin

# 复制插件文件
cp -r my-plugin/* ~/.openclaw/extensions/my-plugin/

# 启用插件（通过配置文件）
cat >> ~/.openclaw/config.json <<'JSON'
{
  "plugins": {
    "my-plugin": {
      "enabled": true
    }
  }
}
JSON
```

### 工作区插件安装

```bash
# 在项目根目录创建插件
mkdir -p ./extensions/my-plugin

# 插件会自动被 OpenClaw 发现和加载
```

### 插件管理命令

```bash
# 列出所有插件
openclaw plugins list

# 启用插件
openclaw plugins enable my-plugin

# 禁用插件
openclaw plugins disable my-plugin

# 查看插件信息
openclaw plugins info my-plugin
```

## 最佳实践

### 1. 错误处理

```typescript
api.on("after_tool_call", async (event, ctx) => {
  try {
    // 你的逻辑
  } catch (error) {
    console.error(`[Plugin] Error:`, error);
    // 不要让插件错误影响主流程
  }
});
```

### 2. 性能优化

```typescript
// 使用异步操作，避免阻塞
api.on("after_tool_call", async (event, ctx) => {
  // 不要等待耗时操作
  someSlowOperation().catch(console.error);

  // 立即返回
});
```

### 3. 配置管理

```typescript
register(api) {
  const config = api.getConfig();
  const enabled = config.enabled ?? true;

  if (!enabled) {
    console.log('[Plugin] Disabled by config');
    return;
  }

  // 注册 hooks
}
```

### 4. 日志规范

```typescript
// 使用统一的日志前缀
console.log(`[${this.name}] Message`);
console.error(`[${this.name}] Error:`, error);
```

### 5. 资源清理

```typescript
export default {
  register(api) {
    const interval = setInterval(() => {
      // 定期任务
    }, 60000);

    // 保存引用以便清理
    this.interval = interval;
  },

  unregister(api) {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }
};
```

## 调试技巧

### 1. 启用详细日志

```bash
# 设置环境变量
export DEBUG=openclaw:*

# 运行 OpenClaw
openclaw
```

### 2. 插件开发模式

```typescript
// 在插件中添加调试信息
register(api) {
  console.log('[Debug] Plugin registered');

  api.on("after_tool_call", async (event, ctx) => {
    console.log('[Debug] Event:', JSON.stringify(event, null, 2));
    console.log('[Debug] Context:', JSON.stringify(ctx, null, 2));
  });
}
```

### 3. 测试插件

```bash
# 创建测试脚本
cat > test-plugin.js <<'JS'
const plugin = require('./extensions/my-plugin');

// 模拟 API
const mockApi = {
  on: (event, handler) => {
    console.log(`Registered handler for: ${event}`);
  },
  getConfig: () => ({ enabled: true })
};

plugin.default.register(mockApi);
JS

node test-plugin.js
```

## 常见问题

### Q1: 插件不生效？

检查：
1. 插件目录结构是否正确
2. `openclaw.plugin.json` 格式是否正确
3. 配置文件中是否启用了插件
4. 查看 OpenClaw 启动日志

### Q2: Hook 执行顺序？

- 使用 `priority` 参数控制（数值越大越先执行）
- 默认 priority 为 0
- 同优先级按注册顺序执行

### Q3: 如何访问 OpenClaw 内部 API？

通过 `api` 对象访问：
```typescript
register(api) {
  // api.on() - 注册 hooks
  // api.getConfig() - 获取配置
  // api.registerTool() - 注册新工具
  // api.registerCommand() - 注册新命令
}
```

### Q4: 插件可以修改 tool 的返回结果吗？

可以，使用 `tool_result_persist` hook（同步）：
```typescript
api.on("tool_result_persist", (event, ctx) => {
  return {
    message: {
      ...event.message,
      content: modifiedContent
    }
  };
});
```

## 参考资源

- OpenClaw 源码：`openclaw_src/src/agents/pi-tool-definition-adapter.ts`
- Hook 定义：`openclaw_src/src/types.ts` (第 298-322 行)
- 内置插件示例：`openclaw_src/extensions/`
- 官方文档：`openclaw_src/docs/`

## 总结

OpenClaw 的插件系统提供了强大的扩展能力：

✅ **无需修改源码** - 通过插件系统实现所有扩展
✅ **完整的 Hook 机制** - 覆盖 tool call 的全生命周期
✅ **灵活的部署方式** - 支持全局、工作区、配置三种方式
✅ **丰富的 API** - 可注册 tools、commands、hooks、services
✅ **性能友好** - after_tool_call 并行执行，不阻塞主流程

通过合理使用插件系统，可以在不侵入源码的情况下实现各种自定义需求。
