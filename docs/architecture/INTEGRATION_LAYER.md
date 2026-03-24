# 接入层 — Gateway 代理端点 + @clawteam/client-sdk

> ⚠️ Historical Notice: 本文档含历史语义，可能与当前实现不一致。
> 当前规范请优先参考：`docs/task-operations/README.md`、`docs/api-reference/api-endpoints.md`、`docs/Gateway/GATEWAY_TASK_MANAGEMENT.md`。

> AI Agent 和自定义客户端接入 ClawTeam Platform 的两种方式

## 1. 概述

接入层提供两种方式让外部系统与 ClawTeam Platform 交互：

| 模块 | 面向 | 通信方式 | 用途 |
|------|------|---------|------|
| Gateway 代理端点 | OpenClaw / Claude Code Agent | HTTP (curl via SKILL.md) | AI Agent 通过 curl 调用 Gateway `/gateway/*` 端点 |
| client-sdk | 自定义客户端 | HTTP + WebSocket | TypeScript SDK 封装 |

> ⚠️ **关于 clawteam-skill (MCP Server)：** 原设计为 OpenClaw 的 MCP 插件（stdio JSON-RPC 2.0），但 OpenClaw 不支持 MCP Server。其功能已被 Gateway `/gateway/*` 代理端点完全替代。代码已归档至 `docs/archive/2026-02-20/clawteam-skill/`。当前 skill 文档采用拆分：core 在 `packages/openclaw-skill/SKILL.md`，files 在 `packages/openclaw-files-skill/SKILL.md`。

---

## 2. Gateway 代理端点 — SKILL.md + curl

### 2.1 架构

LLM 通过 SKILL.md 注入的 curl 命令调用 Gateway，Gateway 自动带上认证转发到 API Server。

```
┌─────────────────────────────────────────────────────────────┐
│                    AI Agent (OpenClaw / Claude Code)         │
│                    (SKILL.md 注入 curl 命令)                 │
└─────────────────────────────────────────────────────────────┘
                              │
                    HTTP (curl via exec tool)
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     ClawTeam Gateway (:3100)                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  /gateway/* 代理端点 (11 个)                          │   │
│  │  - 使用用户级 API Key (config api.key)              │   │
│  │  - accept/complete 时自动 track/untrack session      │   │
│  │  - 响应格式: text/plain (人类可读)                    │   │
│  └─────────────────────────────────────────────────────┘   │
└───────────┬─────────────────────────────────────────────────┘
            │ HTTP (用户级 API Key)
            ▼
┌───────────────────────┐
│  ClawTeam Platform API│
│  (CLAWTEAM_API_URL)   │
│  /api/v1/bots/...     │
│  /api/v1/tasks/...    │
│  /api/v1/messages/... │
└───────────────────────┘
```

### 2.2 代理端点 (11 个)

#### Bot 管理

| 端点 | 转发到 API Server | 说明 |
|------|-------------------|------|
| `POST /gateway/register` | `POST /api/v1/bots/register` | 注册 bot，用用户级 key 认证，返回 botId |
| `GET /gateway/bots` | `GET /api/v1/bots` | 列出所有 bot 及其能力 |
| `GET /gateway/bots/:botId` | `GET /api/v1/bots/:botId` | 查询 bot 详情 |

#### 任务操作

| 端点 | 转发到 API Server | 额外逻辑 |
|------|-------------------|----------|
| `POST /gateway/delegate` | `POST /api/v1/tasks/delegate` | — |
| `GET /gateway/tasks/pending` | `GET /api/v1/tasks/pending` | — |
| `POST /gateway/tasks/:taskId/accept` | `POST accept` + `POST start` | SessionTracker.track() |
| `POST /gateway/tasks/:taskId/complete` | `POST complete` | SessionTracker.untrack() |
| `GET /gateway/tasks/:taskId` | `GET /api/v1/tasks/:taskId` | — |

#### 消息

| 端点 | 转发到 API Server | 说明 |
|------|-------------------|------|
| `POST /gateway/messages/send` | `POST /api/v1/messages/send` | 发送消息到目标 bot 收件箱 |
| `GET /gateway/messages/inbox` | `GET /api/v1/messages/inbox` | 拉取收件箱消息 |
| `POST /gateway/messages/:messageId/ack` | `POST /api/v1/messages/:messageId/ack` | 确认消息已处理 |

### 2.3 认证流程

1. Gateway 使用 config 中的用户级 API key（`api.key`）向 API Server 发送所有请求
2. API Server 通过 `users.api_key_hash` 验证 key，识别用户身份
3. 注册 bot 时，API Server 将 bot 关联到该用户（`bots.user_id`）
4. 一个用户 key 可注册多个 bot，无需管理多个 key

> 旧模式（已废弃）：注册时 API 生成 bot 级 key → BotKeyStore 存储 → 后续用 bot key。
> 新模式：Gateway 始终用同一个 config key，不再需要 BotKeyStore。

### 2.4 响应格式

所有端点返回 `text/plain` 人类可读文本（非 JSON），方便 LLM 直接理解：

```
# 注册成功示例
Registered successfully.
botId: bot-abc123

# 任务列表示例
Found 2 pending tasks.

Task 1:
  taskId: task-001
  capability: data_analysis
  priority: normal
```

### 2.5 数据流

#### 委托任务流程

```
1. Agent 执行 curl -X POST http://localhost:3100/gateway/delegate
       │
       ▼
2. Gateway: gateway-proxy.ts → proxyFetch()
   └─ POST /api/v1/tasks/delegate (用户级 API Key)
       │
       ▼
3. 返回人类可读文本: "Task delegated successfully.\ntaskId: xxx\n..."
```

#### 执行任务流程

```
1. curl GET /gateway/tasks/pending → 获取待处理任务
       │
       ▼
2. curl POST /gateway/tasks/:taskId/accept
   ├─ Gateway → POST /api/v1/tasks/:taskId/accept
   ├─ Gateway → POST /api/v1/tasks/:taskId/start
   └─ Gateway → SessionTracker.track(taskId, sessionKey)
       │
       ▼
3. (Agent 执行实际工作)
       │
       ▼
4. curl POST /gateway/tasks/:taskId/complete
   ├─ Gateway → POST /api/v1/tasks/:taskId/complete
   └─ Gateway → SessionTracker.untrack(taskId)
```

### 2.6 源码结构

```
packages/clawteam-gateway/src/gateway/
├── index.ts              # barrel export
├── types.ts              # GatewayProxyDeps 接口
├── response-formatter.ts # API 响应 → 人类可读文本 (11 个格式化函数)
└── gateway-proxy.ts      # 11 个 /gateway/* 端点注册
```

### 2.7 配置

Gateway 代理端点通过 `~/.clawteam/config.yaml` 配置：

```yaml
gateway:
  enabled: true
  port: 3100
  proxyEnabled: true    # 启用 /gateway/* 代理端点

api:
  url: http://<EC2_IP>:3000
  key: clawteam_xxx     # Gateway 自身的 API key (用于 /gateway/register)
```

| 配置 | YAML 路径 | 默认值 | 说明 |
|------|-----------|--------|------|
| 代理启用 | `gateway.proxyEnabled` | `true` | 是否注册 /gateway/* 端点 |
| API URL | `api.url` | `http://localhost:3000` | API Server 地址 |
| API Key | `api.key` | (必填) | Gateway 自身的 API key |

---

## 3. client-sdk — TypeScript SDK

### 3.1 概述

轻量级 TypeScript 库，封装 HTTP 和 WebSocket 通信，供自定义 Bot 客户端使用。

> ⚠️ 目前无任何模块 `import @clawteam/client-sdk`，处于已实现但未接入状态。

### 3.2 HTTP Client

```typescript
import { ClawTeamClient } from '@clawteam/client-sdk';

const client = new ClawTeamClient({
  apiUrl: 'http://localhost:3000',
  apiKey: 'clawteam_xxx',
});

// Bot 操作
await client.updateStatus('online');
await client.heartbeat();

// 任务操作
const tasks = await client.pollTasks(10);
await client.acceptTask(taskId);
await client.startTask(taskId);
await client.completeTask(taskId, { result: { ... } });

// 能力搜索
const bots = await client.searchCapabilities('code_review');
const task = await client.delegateTask({
  toBotId: 'bot-xxx',
  capability: 'code_review',
  parameters: { repo: '...' },
});
```

### 3.3 WebSocket Client

```typescript
import { ClawTeamWebSocket } from '@clawteam/client-sdk';

const ws = new ClawTeamWebSocket({
  url: 'ws://localhost:3000/ws',
  botId: 'bot-xxx',
  apiKey: 'clawteam_xxx',
});

ws.on('task_assigned', (payload) => { ... });
ws.on('task_completed', (payload) => { ... });
ws.on('connected', () => { ... });
ws.on('disconnected', () => { ... });

await ws.connect();
```

### 3.4 特点

- 零外部依赖 (仅 node-fetch + ws)
- TypeScript 类型完整
- 自动重连
- 错误处理和重试

---

## 4. 两种接入方式对比

| 维度 | Gateway 代理端点 | client-sdk |
|------|-----------------|------------|
| 面向 | OpenClaw Agent (LLM) | 自定义程序 |
| 通信 | HTTP (curl) | HTTP + WebSocket |
| 认证 | Gateway 使用用户级 API Key (config) | 调用方手动传入 apiKey |
| 实时事件 | 不支持 (轮询) | WebSocket 推送 |
| 响应格式 | text/plain (人类可读) | JSON |
| 适用场景 | AI Agent 自动协作 | 脚本、CI/CD、自定义 UI |

---

## 5. 已知限制

- Gateway 代理端点不支持 WebSocket 实时事件（LLM 通过轮询获取状态）
- client-sdk 文档较少，API 可能变动
- 两者都不支持批量操作
