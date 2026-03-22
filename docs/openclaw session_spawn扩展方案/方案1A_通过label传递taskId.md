# 方案 1A：通过 label 传递 taskId

> ⚠️ Historical Notice: 本目录为历史方案调研，不代表当前线上实现。
> 当前实现请参考：`docs/Gateway/GATEWAY_TASK_MANAGEMENT.md`、`docs/Gateway/消息构建器.md`、`docs/task-operations/README.md`。

## 实现思路

利用 `label` 参数传递 `clawteam_taskId`，在 `after_tool_call` hook 中解析并调用 `track_session`。

## 插件实现

### 目录结构

```
~/.openclaw/extensions/clawteam-session-tracker/
├── openclaw.plugin.json
├── index.ts
└── tracker.ts
```

### openclaw.plugin.json

```json
{
  "id": "clawteam-session-tracker",
  "name": "ClawTeam Session Tracker",
  "version": "1.0.0",
  "description": "Track sessions_spawn calls with ClawTeam task IDs",
  "configSchema": {
    "type": "object",
    "properties": {
      "enabled": {
        "type": "boolean",
        "default": true,
        "description": "Enable session tracking"
      },
      "apiEndpoint": {
        "type": "string",
        "description": "ClawTeam API endpoint for tracking"
      },
      "apiKey": {
        "type": "string",
        "description": "API key for authentication"
      },
      "labelPrefix": {
        "type": "string",
        "default": "[TASK:",
        "description": "Prefix to identify taskId in label"
      }
    }
  }
}
```

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
      api.logger.info('[ClawTeam] Session tracking disabled by config');
      return;
    }

    const labelPrefix = config.labelPrefix || '[TASK:';
    const labelPattern = new RegExp(`${escapeRegex(labelPrefix)}([^\\]]+)\\]`);

    api.logger.info('[ClawTeam] Session tracker registered');

    // 注册 after_tool_call hook
    api.on("after_tool_call", async (event, ctx) => {
      // 只处理 sessions_spawn
      if (event.toolName !== "sessions_spawn") {
        return;
      }

      // 检查是否成功
      if (event.result?.status !== "accepted") {
        api.logger.debug('[ClawTeam] Spawn not accepted, skipping tracking');
        return;
      }

      // 从 label 中提取 taskId
      const label = event.params?.label;
      if (!label || typeof label !== 'string') {
        api.logger.debug('[ClawTeam] No label provided, skipping tracking');
        return;
      }

      const match = label.match(labelPattern);
      if (!match) {
        api.logger.debug('[ClawTeam] No taskId found in label, skipping tracking');
        return;
      }

      const clawteam_taskId = match[1].trim();
      const childSessionKey = event.result.childSessionKey;

      if (!childSessionKey) {
        api.logger.warn('[ClawTeam] No childSessionKey in result');
        return;
      }

      // 调用 track_session
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
            task: event.params?.task,
            timestamp: new Date().toISOString()
          }
        });

        api.logger.info(`[ClawTeam] Successfully tracked session ${childSessionKey}`);
      } catch (error) {
        api.logger.error(`[ClawTeam] Failed to track session: ${error.message}`);
        // 不抛出错误，避免影响主流程
      }
    });
  }
};

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

### tracker.ts

```typescript
export interface TrackSessionOptions {
  apiEndpoint?: string;
  apiKey?: string;
  logger?: any;
  metadata?: Record<string, any>;
}

export async function trackSession(
  clawteam_taskId: string,
  childSessionKey: string,
  options: TrackSessionOptions = {}
): Promise<void> {
  const { apiEndpoint, apiKey, logger, metadata } = options;

  // 记录到本地日志
  const logEntry = {
    timestamp: new Date().toISOString(),
    clawteam_taskId,
    childSessionKey,
    ...metadata
  };

  logger?.info('[ClawTeam] Track session:', JSON.stringify(logEntry, null, 2));

  // 如果配置了 API endpoint，发送到远程服务
  if (apiEndpoint) {
    try {
      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
          taskId: clawteam_taskId,
          sessionKey: childSessionKey,
          metadata
        })
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }

      logger?.info(`[ClawTeam] Successfully sent tracking data to ${apiEndpoint}`);
    } catch (error) {
      logger?.error(`[ClawTeam] Failed to send tracking data: ${error.message}`);
      throw error;
    }
  }

  // 可选：写入本地数据库或文件
  await writeToLocalStorage(logEntry, logger);
}

async function writeToLocalStorage(entry: any, logger?: any): Promise<void> {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const os = await import('os');

    const logDir = path.join(os.homedir(), '.openclaw', 'clawteam-tracking');
    await fs.mkdir(logDir, { recursive: true });

    const logFile = path.join(logDir, 'sessions.jsonl');
    await fs.appendFile(logFile, JSON.stringify(entry) + '\n', 'utf-8');

    logger?.debug(`[ClawTeam] Wrote tracking entry to ${logFile}`);
  } catch (error) {
    logger?.warn(`[ClawTeam] Failed to write to local storage: ${error.message}`);
  }
}
```

## 使用方式

### 1. 安装插件

```bash
# 创建插件目录
mkdir -p ~/.openclaw/extensions/clawteam-session-tracker

# 复制文件
cp openclaw.plugin.json ~/.openclaw/extensions/clawteam-session-tracker/
cp index.ts ~/.openclaw/extensions/clawteam-session-tracker/
cp tracker.ts ~/.openclaw/extensions/clawteam-session-tracker/
```

### 2. 配置插件

在 `~/.openclaw/config.json` 中添加：

```json
{
  "plugins": {
    "clawteam-session-tracker": {
      "enabled": true,
      "apiEndpoint": "https://api.clawteam.com/v1/sessions/track",
      "apiKey": "your-api-key-here",
      "labelPrefix": "[TASK:"
    }
  }
}
```

### 3. 调用 sessions_spawn

**方式 1：在 label 中嵌入 taskId**

```typescript
const result = await sessions_spawn({
  task: "Analyze the codebase for security vulnerabilities",
  label: "[TASK:CLAWTEAM-12345] Security Analysis",  // taskId 嵌入在 label 中
  thread: true,
  mode: "session"
});
```

**方式 2：使用辅助函数**

```typescript
function createLabelWithTaskId(taskId: string, description: string): string {
  return `[TASK:${taskId}] ${description}`;
}

const result = await sessions_spawn({
  task: "Analyze the codebase for security vulnerabilities",
  label: createLabelWithTaskId("CLAWTEAM-12345", "Security Analysis"),
  thread: true,
  mode: "session"
});
```

## 工作流程

```
用户调用 sessions_spawn({
  task: "...",
  label: "[TASK:CLAWTEAM-12345] Security Analysis"
})
    ↓
sessions_spawn 执行
    ↓
返回 { status: "accepted", childSessionKey: "agent:main:subagent:abc123", ... }
    ↓
触发 after_tool_call hook
    ↓
插件解析 label，提取 taskId: "CLAWTEAM-12345"
    ↓
调用 track_session("CLAWTEAM-12345", "agent:main:subagent:abc123")
    ↓
    ├─ 写入本地日志：~/.openclaw/clawteam-tracking/sessions.jsonl
    └─ 发送到 API：POST https://api.clawteam.com/v1/sessions/track
```

## 日志输出示例

### 本地日志文件

`~/.openclaw/clawteam-tracking/sessions.jsonl`:

```jsonl
{"timestamp":"2024-01-15T10:30:00.000Z","clawteam_taskId":"CLAWTEAM-12345","childSessionKey":"agent:main:subagent:abc123","runId":"run-xyz789","mode":"session","agentId":"main","parentSessionKey":"main","task":"Analyze the codebase for security vulnerabilities"}
{"timestamp":"2024-01-15T11:45:00.000Z","clawteam_taskId":"CLAWTEAM-12346","childSessionKey":"agent:main:subagent:def456","runId":"run-abc123","mode":"run","agentId":"main","parentSessionKey":"main","task":"Generate test report"}
```

### API 请求示例

```http
POST https://api.clawteam.com/v1/sessions/track
Authorization: Bearer your-api-key-here
Content-Type: application/json

{
  "taskId": "CLAWTEAM-12345",
  "sessionKey": "agent:main:subagent:abc123",
  "metadata": {
    "runId": "run-xyz789",
    "mode": "session",
    "agentId": "main",
    "parentSessionKey": "main",
    "task": "Analyze the codebase for security vulnerabilities",
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
}
```

## 优点

✅ **完全不修改源码** - 通过插件实现
✅ **实现简单** - 只需要一个 hook
✅ **易于维护** - 逻辑集中在插件中
✅ **灵活配置** - 可以通过配置文件控制行为
✅ **不影响主流程** - 即使 tracking 失败也不会影响 spawn

## 缺点

⚠️ **需要约定格式** - label 必须包含特定格式的 taskId
⚠️ **用户需要记住格式** - 容易忘记或写错
⚠️ **label 可能被修改** - 如果其他逻辑也修改 label 可能冲突

## 改进建议

### 1. 提供辅助函数

创建一个辅助库，简化调用：

```typescript
// clawteam-helper.ts
export function spawnWithTracking(params: {
  taskId: string;
  task: string;
  description?: string;
  thread?: boolean;
  mode?: "run" | "session";
  [key: string]: any;
}) {
  const { taskId, description, ...spawnParams } = params;

  return sessions_spawn({
    ...spawnParams,
    label: `[TASK:${taskId}]${description ? ' ' + description : ''}`
  });
}

// 使用
const result = await spawnWithTracking({
  taskId: "CLAWTEAM-12345",
  task: "Analyze the codebase",
  description: "Security Analysis",
  thread: true,
  mode: "session"
});
```

### 2. 支持多种格式

```typescript
// 支持多种 taskId 格式
const patterns = [
  /\[TASK:([^\]]+)\]/,           // [TASK:CLAWTEAM-12345]
  /\[ID:([^\]]+)\]/,              // [ID:12345]
  /taskId[=:]([^\s\]]+)/i,        // taskId=12345 或 taskId:12345
  /#([A-Z]+-\d+)/                 // #CLAWTEAM-12345
];

for (const pattern of patterns) {
  const match = label.match(pattern);
  if (match) {
    clawteam_taskId = match[1].trim();
    break;
  }
}
```

### 3. 添加验证

```typescript
// 验证 taskId 格式
function isValidTaskId(taskId: string): boolean {
  // 例如：CLAWTEAM-12345
  return /^[A-Z]+-\d+$/.test(taskId);
}

if (!isValidTaskId(clawteam_taskId)) {
  api.logger.warn(`[ClawTeam] Invalid taskId format: ${clawteam_taskId}`);
  return;
}
```

## 测试

### 单元测试

```typescript
// test/tracker.test.ts
import { describe, it, expect, vi } from 'vitest';
import { trackSession } from '../tracker.js';

describe('trackSession', () => {
  it('should track session with valid parameters', async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn()
    };

    await trackSession('CLAWTEAM-12345', 'agent:main:subagent:abc123', {
      logger
    });

    expect(logger.info).toHaveBeenCalled();
  });

  it('should send data to API when endpoint is configured', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200
    });

    await trackSession('CLAWTEAM-12345', 'agent:main:subagent:abc123', {
      apiEndpoint: 'https://api.example.com/track',
      apiKey: 'test-key'
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.example.com/track',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-key'
        })
      })
    );
  });
});
```

### 集成测试

```bash
# 测试插件是否正确加载
openclaw plugins list | grep clawteam-session-tracker

# 测试 tracking 功能
openclaw # 启动 CLI
> sessions_spawn({ task: "test", label: "[TASK:TEST-001] Test Task" })

# 检查日志文件
cat ~/.openclaw/clawteam-tracking/sessions.jsonl
```

## 监控和调试

### 查看 tracking 日志

```bash
# 实时监控
tail -f ~/.openclaw/clawteam-tracking/sessions.jsonl | jq

# 查询特定 taskId
grep "CLAWTEAM-12345" ~/.openclaw/clawteam-tracking/sessions.jsonl | jq

# 统计今天的 tracking 数量
grep "$(date +%Y-%m-%d)" ~/.openclaw/clawteam-tracking/sessions.jsonl | wc -l
```

### 调试模式

在配置中启用调试：

```json
{
  "plugins": {
    "clawteam-session-tracker": {
      "enabled": true,
      "debug": true
    }
  }
}
```

在插件中添加调试日志：

```typescript
if (config.debug) {
  api.logger.debug('[ClawTeam] Event:', JSON.stringify(event, null, 2));
  api.logger.debug('[ClawTeam] Context:', JSON.stringify(ctx, null, 2));
}
```
