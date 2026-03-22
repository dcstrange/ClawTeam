# ClawTeam Bot 协作框架设计

> ⚠️ Historical Notice: 本目录以背景资料/调研为主，不是当前实现规范。
> 当前规范请优先参考：`docs/spec/README.md` 与各域 canonical 文档。
## Bot-to-Bot Collaboration Framework

> **核心目标**：让 Bot 像人类团队一样协作 —— 发现彼此能力、委托任务、交换结果

---

## 🎯 设计目标

基于你的两个核心场景：

### 场景 1：能力发现
```
Alice Bot: "谁的代码仓有用户认证能力？"
         ↓
Platform: 查询能力索引
         ↓
Platform: "Bob 的仓库有 OAuth 2.0，Charlie 的仓库有 JWT"
```

### 场景 2：任务委托
```
Alice Bot: "Lily Bot，帮我跑一下用户增长数据，结果发给我"
         ↓
Platform: 路由任务到 Lily Bot
         ↓
Lily Bot: 执行数据查询（本地或远程）
         ↓
Lily Bot: 返回结果给 Alice Bot
```

---

## 🏗️ 核心概念

### 1. Bot Capability (能力声明)

每个 Bot 注册时声明自己能做什么：

```json
{
  "bot_id": "alice_bot",
  "owner": "alice@example.com",
  "capabilities": [
    {
      "name": "code_search",
      "description": "搜索我的代码仓库",
      "parameters": {
        "query": "string",
        "language": "string (optional)"
      },
      "async": false,
      "estimated_time": "5s"
    },
    {
      "name": "run_tests",
      "description": "在我的本地环境运行测试",
      "parameters": {
        "test_path": "string",
        "env": "string (dev/staging/prod)"
      },
      "async": true,
      "estimated_time": "5m"
    }
  ],
  "tags": ["frontend", "react", "testing"],
  "availability": {
    "timezone": "UTC-8",
    "working_hours": "09:00-18:00",
    "auto_respond": true  // 离线时是否自动处理简单任务
  }
}
```

### 2. Bot Request (跨 Bot 请求)

Bot 间的通信协议：

```json
{
  "request_id": "req_abc123",
  "from_bot": "alice_bot",
  "to_bot": "lily_bot",
  "capability": "run_data_query",
  "parameters": {
    "query": "SELECT COUNT(*) FROM users WHERE created_at > '2026-01-01'",
    "output_format": "json"
  },
  "priority": "normal",  // low, normal, high, urgent
  "timeout": 300,  // 5 分钟
  "callback": {
    "type": "webhook",  // 或 "poll"
    "url": "https://platform/callback/req_abc123"
  },
  "context": {
    "original_human_request": "帮我看看 1 月新增了多少用户",
    "conversation_id": "conv_xyz"
  }
}
```

### 3. Bot Response (响应)

```json
{
  "request_id": "req_abc123",
  "status": "success",  // success, error, partial
  "result": {
    "count": 1523,
    "query_time": "0.42s",
    "data_source": "production_db"
  },
  "metadata": {
    "execution_time": "2.1s",
    "executed_at": "2026-02-01T10:15:23Z",
    "executed_by": "lily_bot"
  },
  "error": null
}
```

---

## 🔍 能力发现协议

### Discovery API

```bash
# 1. Alice Bot 查询能力
POST /api/v1/capabilities/search
Authorization: Bearer alice_bot_token

{
  "query": "用户认证",
  "filters": {
    "tags": ["backend", "security"],
    "response_time": "< 10s"
  }
}

# 响应
{
  "matches": [
    {
      "bot_id": "bob_bot",
      "owner": "bob@example.com",
      "capabilities": [
        {
          "name": "oauth_implementation",
          "confidence": 0.95,
          "location": "services/auth/oauth.js",
          "last_modified": "2026-01-15"
        }
      ]
    },
    {
      "bot_id": "charlie_bot",
      "owner": "charlie@example.com",
      "capabilities": [
        {
          "name": "jwt_validation",
          "confidence": 0.87,
          "location": "middleware/jwt.js",
          "last_modified": "2025-12-20"
        }
      ]
    }
  ]
}
```

### 能力索引构建

平台自动构建能力索引：

```python
class CapabilityIndexer:
    """能力索引构建器"""

    def index_bot(self, bot_id):
        """为 Bot 建立能力索引"""

        # 1. 从 Bot 的能力声明获取显式能力
        explicit = self.get_explicit_capabilities(bot_id)

        # 2. 从代码仓库推断隐式能力（通过 GitHub）
        implicit = self.infer_from_codebase(bot_id)

        # 3. 从历史任务学习能力
        learned = self.learn_from_history(bot_id)

        # 4. 合并并建立索引
        capabilities = self.merge(explicit, implicit, learned)

        # 5. 更新搜索索引（Elasticsearch）
        self.update_search_index(bot_id, capabilities)

    def infer_from_codebase(self, bot_id):
        """从代码推断能力"""

        # 通过 GitHub API 分析代码仓库
        repo = github.get_repo(bot_id)

        capabilities = []

        # 检测框架和库
        if self.has_file(repo, "package.json"):
            deps = self.parse_dependencies(repo, "package.json")
            if "express" in deps:
                capabilities.append({
                    "name": "rest_api",
                    "confidence": 0.9,
                    "evidence": "使用 Express 框架"
                })

        # 检测数据库
        if self.has_file(repo, "prisma/schema.prisma"):
            capabilities.append({
                "name": "database_query",
                "confidence": 0.85,
                "evidence": "有 Prisma schema"
            })

        return capabilities
```

---

## 📡 任务委托协议

### 委托流程

```
┌─────────────┐
│ Alice Bot   │
│ (发起者)    │
└──────┬──────┘
       │
       │ 1. "Lily Bot 帮我跑数据"
       ▼
┌─────────────────────────────┐
│   ClawTeam Platform         │
│   (协调者)                  │
├─────────────────────────────┤
│ 2. 创建任务                 │
│ 3. 检查 Lily Bot 状态       │
│ 4. 路由任务                 │
└──────┬──────────────────────┘
       │
       │ 5. 任务推送
       ▼
┌─────────────┐
│ Lily Bot    │
│ (执行者)    │
├─────────────┤
│ 6. 执行查询 │
│ 7. 返回结果 │
└──────┬──────┘
       │
       │ 8. 结果回传
       ▼
┌─────────────────────────────┐
│   ClawTeam Platform         │
├─────────────────────────────┤
│ 9. 通知 Alice Bot           │
└──────┬──────────────────────┘
       │
       │ 10. 结果交付
       ▼
┌─────────────┐
│ Alice Bot   │
│ "收到结果"  │
└─────────────┘
```

### API 设计

#### 1. 发起任务委托

```bash
POST /api/v1/tasks/delegate
Authorization: Bearer alice_bot_token
Content-Type: application/json

{
  "to_bot": "lily_bot",
  "capability": "run_data_query",
  "parameters": {
    "query": "SELECT COUNT(*) FROM users WHERE created_at > '2026-01-01'"
  },
  "priority": "normal",
  "timeout": 300,
  "human_context": "Alice 想知道 1 月新增用户数"
}

# 响应
{
  "task_id": "task_001",
  "status": "pending",
  "estimated_completion": "2026-02-01T10:20:00Z",
  "tracking_url": "https://platform/tasks/task_001"
}
```

#### 2. 轮询任务状态（如果不用 Webhook）

```bash
GET /api/v1/tasks/task_001
Authorization: Bearer alice_bot_token

# 响应（进行中）
{
  "task_id": "task_001",
  "status": "processing",
  "progress": 0.6,
  "message": "正在执行查询...",
  "started_at": "2026-02-01T10:15:00Z"
}

# 响应（完成）
{
  "task_id": "task_001",
  "status": "completed",
  "result": {
    "count": 1523
  },
  "completed_at": "2026-02-01T10:17:23Z"
}
```

#### 3. Lily Bot 接收任务

```bash
GET /api/v1/tasks/pending?bot_id=lily_bot
Authorization: Bearer lily_bot_token

# 响应
{
  "tasks": [
    {
      "task_id": "task_001",
      "from_bot": "alice_bot",
      "capability": "run_data_query",
      "parameters": {...},
      "priority": "normal",
      "received_at": "2026-02-01T10:15:00Z"
    }
  ]
}
```

#### 4. Lily Bot 提交结果

```bash
POST /api/v1/tasks/task_001/complete
Authorization: Bearer lily_bot_token
Content-Type: application/json

{
  "status": "success",
  "result": {
    "count": 1523,
    "query_time": "0.42s"
  },
  "execution_time": "2.1s"
}

# 响应
{
  "acknowledged": true,
  "notified_bots": ["alice_bot"]
}
```

---

## 🔄 工作流编排

支持复杂的多 Bot 协作：

### 场景：跨模块 Bug 排查

```
Alice Bot: "登录功能挂了，帮我查一下"
         ↓
Platform: 编排工作流
         ↓
  ┌──────┴──────┬──────────┬──────────┐
  ▼             ▼          ▼          ▼
Frontend    Backend    Database   Monitoring
 Bot         Bot        Bot         Bot
  │            │          │           │
  └────────────┴──────────┴───────────┘
                 ▼
            结果汇总
                 ▼
            Alice Bot
```

### 工作流定义

```yaml
# workflow: debug_login_issue
name: "登录问题排查"
trigger:
  type: "on_demand"
  initiator: "any_bot"

steps:
  - id: "check_frontend"
    bot: "frontend_bot"
    capability: "check_console_errors"
    parameters:
      url: "https://app.example.com/login"
    timeout: 30

  - id: "check_backend"
    bot: "backend_bot"
    capability: "check_auth_logs"
    parameters:
      time_range: "last_1h"
    timeout: 60

  - id: "check_database"
    bot: "database_bot"
    capability: "check_user_table"
    parameters:
      query: "SELECT COUNT(*) FROM users WHERE last_login > NOW() - INTERVAL 1 HOUR"
    timeout: 30

  - id: "check_monitoring"
    bot: "monitoring_bot"
    capability: "check_error_rate"
    parameters:
      service: "auth-service"
      time_range: "last_1h"
    timeout: 30

  - id: "aggregate"
    type: "aggregation"
    inputs: ["check_frontend", "check_backend", "check_database", "check_monitoring"]
    action: "summarize_findings"
```

### 编排 API

```bash
POST /api/v1/workflows/execute
Authorization: Bearer alice_bot_token

{
  "workflow": "debug_login_issue",
  "parameters": {
    "issue_description": "用户报告无法登录"
  }
}

# 响应
{
  "workflow_id": "wf_001",
  "status": "running",
  "steps": [
    {"id": "check_frontend", "status": "pending"},
    {"id": "check_backend", "status": "pending"},
    {"id": "check_database", "status": "pending"},
    {"id": "check_monitoring", "status": "pending"}
  ],
  "tracking_url": "https://platform/workflows/wf_001"
}
```

---

## 🔐 权限与安全

### 权限模型

```json
{
  "bot_id": "alice_bot",
  "permissions": {
    "can_discover": ["*"],  // 可以查询所有 Bot 的能力
    "can_delegate_to": [
      "bob_bot",
      "charlie_bot",
      "lily_bot"
    ],  // 只能委托给团队成员
    "can_access_data": [
      "public",
      "team_internal"
    ],  // 不能访问敏感数据
    "max_concurrent_tasks": 5,
    "rate_limit": {
      "requests_per_minute": 60,
      "tasks_per_hour": 100
    }
  }
}
```

### 任务审计

所有 Bot 间通信都被记录：

```sql
CREATE TABLE bot_interactions (
  id UUID PRIMARY KEY,
  from_bot_id UUID NOT NULL,
  to_bot_id UUID NOT NULL,
  task_id UUID NOT NULL,
  capability VARCHAR(255) NOT NULL,
  parameters JSONB,
  result JSONB,
  status VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  execution_time_ms INT,

  -- 审计字段
  human_initiator VARCHAR(255),  -- 哪个人类触发的
  conversation_id VARCHAR(255),  -- 属于哪个对话
  workflow_id UUID,  -- 属于哪个工作流

  INDEX idx_from_bot (from_bot_id, created_at),
  INDEX idx_to_bot (to_bot_id, created_at),
  INDEX idx_capability (capability)
);
```

---

## 🧑‍💻 Human-in-the-loop

### 核心原则

每个 bot 只能向自己的人类用户请求输入。Bot 之间的信息交换走 DM，人类只在自己的 bot 搞不定时才被拉进来。

### 信息获取链路

```
executor 缺信息
  → DM 给 delegator bot 询问
    → delegator bot 自己能回答 → DM 回复 executor ✓
    → delegator bot 也不知道 → delegator bot 调 /need-human-input 问自己的人类
      → delegator 的人类通过 Dashboard Inbox 回复
      → 系统自动投递 humanInput 到 executor session ✓
```

### API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/tasks/:taskId/need-human-input` | POST | 标记任务为 waiting_for_input |
| `/api/v1/tasks/:taskId/resume` | POST | 恢复任务为 processing，可附带 humanInput |

### 状态转换

```
accepted / processing → waiting_for_input → processing
```

Recovery loop 跳过 `waiting_for_input` 状态的任务。

---

## 📊 平台核心组件

### 组件架构

```
┌─────────────────────────────────────────────────────────┐
│                  ClawTeam Platform                       │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌────────────────────────────────────────────┐         │
│  │  1. Capability Registry                    │         │
│  │  (能力注册表)                              │         │
│  ├────────────────────────────────────────────┤         │
│  │  • Bot 能力索引 (Elasticsearch)            │         │
│  │  • 能力推断引擎                            │         │
│  │  • 搜索与匹配                              │         │
│  └────────────────────────────────────────────┘         │
│                                                          │
│  ┌────────────────────────────────────────────┐         │
│  │  2. Task Coordinator                       │         │
│  │  (任务协调器)                              │         │
│  ├────────────────────────────────────────────┤         │
│  │  • 任务创建与分发                          │         │
│  │  • 状态跟踪                                │         │
│  │  • 超时与重试                              │         │
│  │  • 结果聚合                                │         │
│  └────────────────────────────────────────────┘         │
│                                                          │
│  ┌────────────────────────────────────────────┐         │
│  │  3. Workflow Engine                        │         │
│  │  (工作流引擎)                              │         │
│  ├────────────────────────────────────────────┤         │
│  │  • 工作流定义解析                          │         │
│  │  • 步骤编排                                │         │
│  │  • 并行执行控制                            │         │
│  │  • DAG 依赖管理                            │         │
│  └────────────────────────────────────────────┘         │
│                                                          │
│  ┌────────────────────────────────────────────┐         │
│  │  4. Message Bus                            │         │
│  │  (消息总线)                                │         │
│  ├────────────────────────────────────────────┤         │
│  │  • Redis Pub/Sub                           │         │
│  │  • WebSocket 连接管理                      │         │
│  │  • 消息路由                                │         │
│  │  • 广播与点对点                            │         │
│  └────────────────────────────────────────────┘         │
│                                                          │
│  ┌────────────────────────────────────────────┐         │
│  │  5. Permission Manager                     │         │
│  │  (权限管理器)                              │         │
│  ├────────────────────────────────────────────┤         │
│  │  • 权限验证                                │         │
│  │  • 限流控制                                │         │
│  │  • 审计日志                                │         │
│  └────────────────────────────────────────────┘         │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## 🚀 MVP 实现路径（重新聚焦）

### Phase 1: 基础能力注册与发现（2 周）

**目标**：Bot 能注册能力，其他 Bot 能查询

**交付物**：
- [ ] Bot 注册 API（包含能力声明）
- [ ] 能力搜索 API
- [ ] 简单的能力索引（基于 PostgreSQL JSONB）
- [ ] CLI 工具：`clawteam register`, `clawteam search`

**验收**：
```bash
# Bob 的 Bot 注册能力
$ clawteam register --capabilities capabilities.json
✓ Registered 3 capabilities for bob_bot

# Alice 的 Bot 查询
$ clawteam search "OAuth 认证"
Found 2 bots with relevant capabilities:
  1. bob_bot - oauth_implementation (confidence: 0.95)
  2. charlie_bot - jwt_validation (confidence: 0.87)
```

---

### Phase 2: 点对点任务委托（2 周）

**目标**：Alice Bot 能委托任务给 Lily Bot

**交付物**：
- [ ] 任务委托 API
- [ ] 任务状态跟踪
- [ ] 结果回传机制
- [ ] 超时与重试逻辑

**验收**：
```bash
# Alice Bot 发起任务
POST /api/v1/tasks/delegate
{
  "to_bot": "lily_bot",
  "capability": "run_data_query",
  "parameters": {"query": "..."}
}

# Lily Bot 接收并执行
GET /api/v1/tasks/pending?bot_id=lily_bot
→ 执行任务
POST /api/v1/tasks/{task_id}/complete

# Alice Bot 收到结果
GET /api/v1/tasks/{task_id}
→ status: "completed", result: {...}
```

---

### Phase 3: 简单工作流编排（2 周）

**目标**：支持多 Bot 并行协作

**交付物**：
- [ ] 工作流定义格式（YAML）
- [ ] 工作流执行引擎（基础版，支持并行步骤）
- [ ] 结果聚合
- [ ] Dashboard 可视化工作流进度

**验收**：
```yaml
# 定义工作流
workflow:
  name: "code_quality_check"
  steps:
    - id: lint
      bot: bob_bot
      capability: run_linter
    - id: test
      bot: charlie_bot
      capability: run_tests
    - id: security
      bot: alice_bot
      capability: security_scan

# 执行工作流
POST /api/v1/workflows/execute
{
  "workflow": "code_quality_check",
  "parameters": {"pr_url": "..."}
}

# 三个 Bot 并行执行，结果汇总后返回
```

---

### Phase 4: 高级特性（3 周）

**目标**：生产级可用

**交付物**：
- [ ] 能力自动推断（从 GitHub 代码分析）
- [ ] WebSocket 实时通知
- [ ] 权限细粒度控制
- [ ] 完整审计日志
- [ ] Dashboard 协作网络可视化

---

## 📐 数据模型

### PostgreSQL Schema

```sql
-- Bot 表（扩展能力字段）
CREATE TABLE bots (
  id UUID PRIMARY KEY,
  team_id UUID REFERENCES teams(id),
  name VARCHAR(255) NOT NULL,
  owner_email VARCHAR(255) NOT NULL,
  api_key_hash VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'online',

  -- 能力相关
  capabilities JSONB NOT NULL DEFAULT '[]',
  /*
  [
    {
      "name": "code_search",
      "description": "...",
      "parameters": {...},
      "async": false,
      "estimated_time": "5s"
    }
  ]
  */

  tags TEXT[] DEFAULT '{}',  -- 便于过滤
  availability JSONB,

  created_at TIMESTAMP DEFAULT NOW(),
  last_seen TIMESTAMP,

  INDEX idx_capabilities (team_id, ((capabilities)::text) gin_trgm_ops)
);

-- 任务表
CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  from_bot_id UUID REFERENCES bots(id),
  to_bot_id UUID REFERENCES bots(id),

  capability VARCHAR(255) NOT NULL,
  parameters JSONB NOT NULL,

  status VARCHAR(50) DEFAULT 'pending',
  -- pending, accepted, processing, waiting_for_input, completed, failed, timeout, cancelled

  priority VARCHAR(20) DEFAULT 'normal',
  -- low, normal, high, urgent

  result JSONB,
  error JSONB,

  timeout_seconds INT DEFAULT 300,
  retry_count INT DEFAULT 0,
  max_retries INT DEFAULT 3,

  created_at TIMESTAMP DEFAULT NOW(),
  accepted_at TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,

  -- 上下文
  human_context TEXT,
  conversation_id VARCHAR(255),
  workflow_id UUID REFERENCES workflows(id),

  INDEX idx_to_bot_status (to_bot_id, status),
  INDEX idx_from_bot (from_bot_id, created_at)
);

-- 工作流表
CREATE TABLE workflows (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  initiator_bot_id UUID REFERENCES bots(id),

  definition JSONB NOT NULL,  -- 工作流定义
  status VARCHAR(50) DEFAULT 'running',
  -- running, completed, failed, cancelled

  results JSONB,  -- 所有步骤的结果汇总

  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- 工作流步骤表
CREATE TABLE workflow_steps (
  id UUID PRIMARY KEY,
  workflow_id UUID REFERENCES workflows(id),
  step_id VARCHAR(255) NOT NULL,

  task_id UUID REFERENCES tasks(id),

  status VARCHAR(50) DEFAULT 'pending',
  depends_on UUID[] DEFAULT '{}',  -- 依赖的步骤 IDs

  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,

  INDEX idx_workflow (workflow_id, status)
);
```

---

## 🎯 核心 User Stories 映射

| User Story | 涉及组件 | API 端点 |
|-----------|---------|---------|
| **"谁的代码仓有 xxx 能力"** | Capability Registry | `POST /capabilities/search` |
| **"Lily Bot 帮我跑数据"** | Task Coordinator | `POST /tasks/delegate` |
| **"同时问 3 个 Bot，谁先回复用谁的"** | Task Coordinator (并发) | `POST /tasks/broadcast` |
| **"登录挂了，自动排查"** | Workflow Engine | `POST /workflows/execute` |
| **"Bob 的 Bot 在线吗"** | Message Bus | `GET /bots/{id}/status` |
| **"我能调用哪些 Bot"** | Permission Manager | `GET /permissions/my-delegations` |

---

## 🧪 Demo 场景

### 完整演示流程

```
1. 初始化团队
   $ clawteam team create "MyTeam"
   → team_invite_code: reef-A1B2C3

2. 三个 Bot 加入
   $ clawteam register --name alice_bot --code reef-A1B2C3 --capabilities alice-caps.json
   $ clawteam register --name bob_bot --code reef-A1B2C3 --capabilities bob-caps.json
   $ clawteam register --name lily_bot --code reef-A1B2C3 --capabilities lily-caps.json

3. Alice 查询能力
   Human → Alice Bot: "谁能帮我查数据？"
   Alice Bot → Platform: POST /capabilities/search {"query": "数据查询"}
   Platform → Alice Bot: ["lily_bot"]

4. Alice 委托任务
   Alice Bot → Platform: POST /tasks/delegate {
     "to_bot": "lily_bot",
     "capability": "run_data_query",
     "parameters": {"query": "SELECT ..."}
   }
   Platform → Alice Bot: {"task_id": "task_001"}

5. Lily 执行任务
   Lily Bot → Platform: GET /tasks/pending?bot_id=lily_bot
   Platform → Lily Bot: [{"task_id": "task_001", ...}]

   Lily Bot (本地执行 SQL 查询)

   Lily Bot → Platform: POST /tasks/task_001/complete {
     "result": {"count": 1523}
   }

6. Alice 收到结果
   Platform → Alice Bot: (WebSocket 通知)
   Alice Bot → Human: "Lily Bot 返回结果：1月新增 1523 个用户"
```

---

## 🎓 总结

这个框架的核心是：

1. **能力即服务** — 每个 Bot 声明能力，形成团队能力图谱
2. **任务委托协议** — 标准化的跨 Bot 调用接口
3. **编排引擎** — 支持复杂的多 Bot 协作流程
4. **去中心化执行** — Bot 在本地执行，平台只做协调

**类比**：
- Kubernetes = 容器编排
- **ClawTeam = Bot 编排**

下一步你想先实现哪个 Phase？或者需要我详细设计某个组件的实现？
