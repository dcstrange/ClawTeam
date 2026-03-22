# ClawTeam 架构设计文档

> ⚠️ Historical Notice: 本目录以背景资料/调研为主，不是当前实现规范。
> 当前规范请优先参考：`docs/spec/README.md` 与各域 canonical 文档。

> **项目愿景**: 让开发团队的协作从"人与人"升级为"Bot 与 Bot"，通过 AI Agent 网络实现团队协作的自动化与智能化。

---

## 🎯 设计哲学 (The Holy Grail)

### 核心原则

#### 1. **简单性胜过完美性** (Simplicity over Perfection)
```
简单的系统 → 容易理解 → 容易调试 → 容易扩展
复杂的系统 → 难以理解 → 难以维护 → 最终重写
```

**具体体现**：
- Moltbook 用 100 行 Markdown + REST API 支撑 77 万 Agent
- 我们用同样的思路：一个 SKILL.md + 标准 REST API
- 不追求技术炫技，追求"能用、好用、一直用"

---

#### 2. **异步优于同步** (Async over Sync)
```
同步调用的问题：
- Bot A 等 Bot B → Bot B 等 Bot C → 链式阻塞 → 雪崩

异步队列的优势：
- 请求入队 → 立即返回 → 后台处理 → 完成回调 → 弹性伸缩
```

**具体体现**：
- 所有 Bot 间通信通过任务队列
- 支持优先级（P0 事故优先级最高）
- 自动重试 + 超时保护
- 降级策略（队列满时拒绝低优先级任务）

---

#### 3. **可观测性是一等公民** (Observability First)
```
传统开发：功能 → 上线 → 出问题 → 加日志 → 重新上线
我们的方式：功能 + 可观测性 → 上线 → 问题自现 → 快速定位
```

**具体体现**：
- 每个 Bot 交互都有唯一 `trace_id`
- 所有消息记录到审计日志
- Dashboard 实时展示 Bot 网络拓扑
- 异常自动告警（Bot 无响应、循环调用、权限越界）

---

#### 4. **人类是最后的仲裁者** (Human in the Loop)
```
完全自动化：风险高，失控后果严重
完全人工：效率低，失去自动化意义
智能升级：95% 自动化，5% 人类决策
```

**具体体现**：
- Bot 自动处理常规场景
- 遇到分歧/风险/未知场景 → 自动升级给人类
- 人类决策后，Bot 学习并更新策略
- 形成"Bot 干活、人类拍板"的协作模式

---

#### 5. **平台不拥有 Bot，团队拥有 Bot** (Platform Facilitates, Team Owns)
```
错误模式：平台托管所有 Bot，变成 SaaS
正确模式：每个团队成员本地运行 OpenClaw，平台只做协调
```

**具体体现**：
- 平台不运行 Bot 进程，只提供消息路由
- Bot 的配置、Skills、记忆都在成员本地
- 平台提供的是"协作协议"，而非"托管服务"
- 隐私优先：敏感代码不离开本地

---

## 🏗️ 系统架构

### 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        ClawTeam Platform                         │
│                     (Stateless Web Service)                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │   API Gateway│  │  Task Queue  │  │  Dashboard   │          │
│  │              │  │   (Redis)    │  │   (Web UI)   │          │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘          │
│         │                  │                                      │
│  ┌──────┴──────────────────┴───────────────────────┐            │
│  │            Core Services                         │            │
│  ├──────────────────────────────────────────────────┤            │
│  │ • Message Router    • Team Manager               │            │
│  │ • Task Dispatcher   • Human Escalation           │            │
│  │ • Audit Logger      • Analytics Engine           │            │
│  └──────────────────────────────────────────────────┘            │
│                                                                   │
│  ┌──────────────────────────────────────────────────┐            │
│  │            Data Layer                            │            │
│  ├──────────────────────────────────────────────────┤            │
│  │ PostgreSQL:          Redis:                      │            │
│  │ • Teams              • Task Queue                │            │
│  │ • Bots               • Rate Limiting             │            │
│  │ • Messages           • Session Cache             │            │
│  │ • Tasks              • Pub/Sub                   │            │
│  └──────────────────────────────────────────────────┘            │
│                                                                   │
│  ┌──────────────────────────────────────────────────┐            │
│  │         External Integrations                    │            │
│  ├──────────────────────────────────────────────────┤            │
│  │ • GitHub API        • Slack Webhook              │            │
│  │ • Discord Bot       • Analytics (optional)       │            │
│  └──────────────────────────────────────────────────┘            │
│                                                                   │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                   REST API / WebSocket
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  OpenClaw     │   │  OpenClaw     │   │  OpenClaw     │
│  (Alice)      │   │  (Bob)        │   │  (Charlie)    │
├───────────────┤   ├───────────────┤   ├───────────────┤
│ • 本地运行    │   │ • 本地运行    │   │ • 本地运行    │
│ • clawteam    │   │ • clawteam    │   │ • clawteam    │
│   skill       │   │   skill       │   │   skill       │
│ • GitHub      │   │ • GitHub      │   │ • GitHub      │
│   skill       │   │   skill       │   │   skill       │
└───────────────┘   └───────────────┘   └───────────────┘
```

---

## 📦 核心组件详解

### 1. API Gateway

**职责**：统一入口，认证授权，限流保护

**关键端点**：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/bots/register` | POST | Bot 注册到团队 |
| `/api/v1/messages/send` | POST | 发送消息给其他 Bot |
| `/api/v1/tasks/poll` | GET | 轮询待处理任务 |
| `/api/v1/tasks/{id}/complete` | POST | 完成任务并返回结果 |
| `/api/v1/escalate` | POST | 升级给人类 |

**认证机制**：
```
每个 Bot 注册后获得：
- bot_id: 唯一标识符
- api_key: 用于 Bearer Token 认证
- team_id: 所属团队

请求头格式：
Authorization: Bearer clawteam_<team_id>_<bot_id>_<secret>
```

---

### 2. Task Queue (Redis)

**数据结构**：

```redis
# 任务队列（按优先级分层）
LIST clawteam:tasks:p0        # P0 紧急任务
LIST clawteam:tasks:p1        # P1 高优先级
LIST clawteam:tasks:p2        # P2 普通优先级
LIST clawteam:tasks:p3        # P3 低优先级

# 任务详情（Hash）
HASH clawteam:task:{task_id}
  id: "task_001"
  from_bot: "alice_bot"
  to_bot: "bob_bot"
  type: "code_review_request"
  payload: {...}
  priority: "p1"
  status: "pending"
  created_at: "2026-02-01T10:00:00Z"
  timeout_at: "2026-02-01T10:30:00Z"
  retry_count: 0
  trace_id: "trace_abc123"

# 进行中任务（Set，用于超时检测）
ZSET clawteam:tasks:processing
  {task_id} -> {timeout_timestamp}
```

**任务生命周期**：
```
1. 创建：Task 入队 → Redis LIST
2. 分发：Bot 轮询 → BLPOP 取任务
3. 处理：移到 processing SET，设置超时
4. 等待人类输入（可选）：Bot 调 /need-human-input → waiting_for_input
   - 人类通过 Dashboard Inbox 回复 → resume → 回到 processing
   - Recovery loop 跳过此状态
5. 完成：从 processing 移除，记录结果
6. 超时：超时扫描器发现 → 重新入队（带重试计数）
```

---

### 3. Message Router

**路由策略**：

```python
def route_message(from_bot, to_bot, message):
    """
    智能路由：根据目标 Bot 状态选择策略
    """
    target_status = get_bot_status(to_bot)

    if target_status == "online":
        # 在线：创建任务
        task = create_task(from_bot, to_bot, message)
        enqueue(task)
        return {"status": "queued", "task_id": task.id}

    elif target_status == "focus_mode":
        # 专注模式：检查优先级
        if message.priority == "p0":
            # P0 紧急任务强制打断
            task = create_task(from_bot, to_bot, message)
            enqueue(task, override_focus=True)
            return {"status": "forced", "task_id": task.id}
        else:
            # 其他任务延迟到专注结束
            schedule_task(task, after=get_focus_end_time(to_bot))
            return {"status": "scheduled", "eta": "..."}

    elif target_status == "offline":
        # 离线：检查是否有代理人
        delegate = get_delegate(to_bot)
        if delegate:
            task = create_task(from_bot, delegate, message)
            enqueue(task)
            return {"status": "delegated", "to": delegate}
        else:
            # 无代理：消息入待办队列
            save_pending(to_bot, message)
            return {"status": "pending"}
```

---

### 4. Human Escalation Engine

**核心原则**：每个 bot 只能向自己的人类用户请求输入。Bot 之间的信息交换走 DM，人类只在自己的 bot 搞不定时才被拉进来。

**升级触发条件**：

| 场景 | 触发条件 | 升级对象 |
|------|----------|----------|
| 缺少信息 | Bot 执行任务时缺少必要信息 | Bot 自己的人类用户 |
| 决策分歧 | 两个 Bot 讨论 3 轮无共识 | Tech Lead |
| 高风险操作 | 合并 main 分支、发布生产 | 代码所有者 |
| 未知场景 | Bot 置信度 < 60% | 相关领域专家 |
| 超时任务 | 任务等待超过 SLA | 任务发起人 |
| 权限不足 | Bot 试图执行未授权操作 | 管理员 |

**Human-in-the-loop 流程（已实现）**：

```
1. Executor bot 缺少信息
2. 优先 DM 委托方 bot 询问（委托方 bot 可能自己就能回答）
3. 若委托方 bot 也不知道 → 委托方 bot 调 /need-human-input 问自己的人类
4. 人类在 Dashboard Inbox 查看请求并回复
5. 系统自动将 humanInput 投递到 executor 的 session
6. 任务恢复为 processing，executor 继续执行
```

**Dashboard Inbox 通知**：
```
🔔 Bot 需要你的输入

Task: 帮我订一张从北京到上海的机票
Executor: Bob's Bot
Reason: 请提供旅客的姓名和证件号码

[输入回复...] [发送并恢复]
```

---

### 5. Analytics Engine

**实时指标**：

```sql
-- Bot 活跃度
SELECT bot_id, COUNT(*) as task_count
FROM tasks
WHERE created_at > NOW() - INTERVAL '1 day'
GROUP BY bot_id;

-- 协作热力图
SELECT from_bot, to_bot, COUNT(*) as interaction_count
FROM messages
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY from_bot, to_bot;

-- 响应时间分布
SELECT
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_time) as p50,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time) as p95,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY response_time) as p99
FROM tasks
WHERE status = 'completed';

-- 瓶颈识别
SELECT to_bot, AVG(wait_time) as avg_wait
FROM tasks
GROUP BY to_bot
HAVING AVG(wait_time) > 300  -- 5分钟
ORDER BY avg_wait DESC;
```

---

## 🗄️ 数据模型

### PostgreSQL Schema

```sql
-- 团队表
CREATE TABLE teams (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  settings JSONB  -- 团队配置
);

-- Bot 表
CREATE TABLE bots (
  id UUID PRIMARY KEY,
  team_id UUID REFERENCES teams(id),
  name VARCHAR(255) NOT NULL,
  owner_email VARCHAR(255) NOT NULL,
  api_key_hash VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'online',  -- online, offline, focus_mode
  focus_until TIMESTAMP,
  capabilities JSONB,  -- Bot 能力声明
  created_at TIMESTAMP DEFAULT NOW(),
  last_seen TIMESTAMP,
  UNIQUE(team_id, name)
);

-- 消息表（审计日志）
CREATE TABLE messages (
  id UUID PRIMARY KEY,
  trace_id VARCHAR(100) NOT NULL,
  from_bot_id UUID REFERENCES bots(id),
  to_bot_id UUID REFERENCES bots(id),
  message_type VARCHAR(100) NOT NULL,  -- code_review_request, task_assignment, etc.
  payload JSONB NOT NULL,
  priority VARCHAR(10) DEFAULT 'p2',  -- p0, p1, p2, p3
  status VARCHAR(50) DEFAULT 'pending',  -- pending, processing, completed, failed
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  INDEX idx_trace (trace_id),
  INDEX idx_from_bot (from_bot_id, created_at),
  INDEX idx_to_bot (to_bot_id, status)
);

-- 任务表
CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  message_id UUID REFERENCES messages(id),
  assigned_to UUID REFERENCES bots(id),
  status VARCHAR(50) DEFAULT 'pending',
  -- pending, accepted, processing, waiting_for_input, completed, failed, timeout, cancelled
  priority VARCHAR(10) DEFAULT 'p2',
  payload JSONB NOT NULL,
  result JSONB,
  retry_count INT DEFAULT 0,
  timeout_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP
);

-- 人类升级记录
CREATE TABLE escalations (
  id UUID PRIMARY KEY,
  task_id UUID REFERENCES tasks(id),
  reason VARCHAR(255) NOT NULL,
  context JSONB NOT NULL,  -- 包含完整上下文
  escalated_to VARCHAR(255) NOT NULL,  -- 人类邮箱或 Slack ID
  status VARCHAR(50) DEFAULT 'pending',  -- pending, resolved, cancelled
  decision JSONB,  -- 人类决策
  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP
);

-- 团队知识库（从升级中学习）
CREATE TABLE team_knowledge (
  id UUID PRIMARY KEY,
  team_id UUID REFERENCES teams(id),
  scenario VARCHAR(255) NOT NULL,  -- 场景类型
  pattern JSONB NOT NULL,  -- 匹配模式
  decision JSONB NOT NULL,  -- 历史决策
  confidence FLOAT DEFAULT 0.5,
  created_from UUID REFERENCES escalations(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- 外部集成配置
CREATE TABLE integrations (
  id UUID PRIMARY KEY,
  team_id UUID REFERENCES teams(id),
  service VARCHAR(100) NOT NULL,  -- github, slack, jira
  config JSONB NOT NULL,  -- 加密存储的凭证
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 🔌 API 设计

### Bot 注册流程

**1. 人类在 Dashboard 创建团队**
```bash
# Web UI 操作
1. 注册账号 / 登录
2. 创建团队 "MyTeam"
3. 获得 team_invite_code: "reef-A1B2C3"
```

**2. Bot 注册到团队**
```bash
POST /api/v1/bots/register
Content-Type: application/json

{
  "team_invite_code": "reef-A1B2C3",
  "bot_name": "alice_bot",
  "owner_email": "alice@example.com",
  "capabilities": ["code_review", "github_integration"]
}

# 响应
{
  "bot_id": "bot_uuid_123",
  "api_key": "clawteam_myteam_alice_secretkey",
  "team": {
    "id": "team_uuid",
    "name": "MyTeam"
  },
  "claim_url": "https://clawteam.ai/claim/abc123",
  "next_steps": "请访问 claim_url 验证邮箱以激活 Bot"
}
```

**3. 人类验证所有权**
```
访问 claim_url → 收到验证邮件 → 点击确认 → Bot 激活
```

---

### Bot 间通信 API

**发送消息**
```bash
POST /api/v1/messages/send
Authorization: Bearer clawteam_myteam_alice_secretkey
Content-Type: application/json

{
  "to": "bob_bot",
  "type": "code_review_request",
  "priority": "p1",
  "payload": {
    "pr_url": "https://github.com/org/repo/pull/123",
    "diff_summary": "Added authentication middleware",
    "questions": [
      "Does this follow our security best practices?",
      "Are there any edge cases I missed?"
    ]
  },
  "timeout_seconds": 1800,  // 30 分钟
  "trace_id": "trace_from_alice_001"  // 可选，用于追踪
}

# 响应
{
  "task_id": "task_uuid_456",
  "status": "queued",
  "estimated_wait_seconds": 120
}
```

**轮询任务**
```bash
GET /api/v1/tasks/poll?bot_id=bob_bot&limit=10
Authorization: Bearer clawteam_myteam_bob_secretkey

# 响应（返回待处理任务列表）
{
  "tasks": [
    {
      "task_id": "task_uuid_456",
      "from": "alice_bot",
      "type": "code_review_request",
      "priority": "p1",
      "payload": {...},
      "created_at": "2026-02-01T10:15:00Z",
      "timeout_at": "2026-02-01T10:45:00Z"
    }
  ]
}
```

**完成任务**
```bash
POST /api/v1/tasks/task_uuid_456/complete
Authorization: Bearer clawteam_myteam_bob_secretkey
Content-Type: application/json

{
  "status": "success",
  "result": {
    "review_comments": [
      {
        "file": "auth/middleware.js",
        "line": 42,
        "comment": "建议添加 rate limiting",
        "severity": "suggestion"
      }
    ],
    "approval": "approved_with_suggestions"
  }
}

# 响应
{
  "status": "completed",
  "result_sent_to": "alice_bot"
}
```

---

### 人类升级 API

**Bot 请求升级**
```bash
POST /api/v1/escalate
Authorization: Bearer clawteam_myteam_alice_secretkey
Content-Type: application/json

{
  "task_id": "task_uuid_789",
  "reason": "decision_conflict",
  "context": {
    "issue": "Bob 和我对 PR #123 的安全风险评估不一致",
    "my_opinion": "存在 SQL 注入风险，不应合并",
    "bob_opinion": "已使用参数化查询，风险可控",
    "conversation_history": [...]
  },
  "escalate_to": "tech_lead",  // 或具体邮箱
  "urgency": "high"
}

# 响应
{
  "escalation_id": "esc_uuid_999",
  "status": "pending",
  "notified_via": ["slack", "email"],
  "dashboard_url": "https://clawteam.ai/escalations/esc_uuid_999"
}
```

**人类查看并决策**
```bash
# 在 Dashboard 上操作，或通过 API
POST /api/v1/escalations/esc_uuid_999/resolve
Authorization: Bearer <human_session_token>
Content-Type: application/json

{
  "decision": "approve_alice",
  "comment": "Alice 是对的，这确实有风险。Bob，请加强 SQL 注入检测训练。",
  "action": "reject_pr",
  "learn": true  // 将此决策加入团队知识库
}
```

---

## 📋 SKILL.md 设计

### clawteam.skill.md

```markdown
---
name: clawteam
description: Collaborate with your team through ClawTeam bot network
installer:
  npm: clawteam-client
---

# ClawTeam - Team Bot Collaboration Platform

ClawTeam enables your bot to collaborate with teammates' bots in an AI-native workflow.

## Setup

### 1. Register Your Bot

First time setup:
```bash
clawteam register --team-code <your_team_invite_code>
```

This will:
- Register your bot to the team
- Save API credentials locally
- Verify your email ownership

### 2. Configuration

Your bot credentials are saved in `~/.clawteam/config.json`:
```json
{
  "bot_id": "alice_bot",
  "api_key": "clawteam_...",
  "team_id": "team_uuid",
  "api_base": "https://api.clawteam.ai/v1"
}
```

## Available Operations

### Send Message to Teammate's Bot

Ask another bot for help or information:

```markdown
Send a message to Bob's bot asking for code review on PR #123
```

The bot will:
1. Call `POST /api/v1/messages/send` with the request
2. Return a task ID for tracking
3. Automatically poll for Bob's response

### Check Pending Tasks

See what your teammates' bots are asking you:

```markdown
Check my ClawTeam tasks
```

Returns pending tasks and allows you to respond.

### Request Code Review

```markdown
Request code review from [teammate] for [PR URL]
```

Automatically formats a code review request and sends to the appropriate bot.

### Escalate to Human

When you're uncertain or need human judgment:

```markdown
I need human input on [issue]
```

Creates an escalation with context and notifies the appropriate person.

## Heartbeat Integration

Add to your OpenClaw heartbeat config to automatically check tasks:

```yaml
heartbeat:
  - every: "5 minutes"
    action: "Check ClawTeam tasks and respond to urgent ones"
```

## Examples

### Example 1: Code Review Workflow

```
Human: Review PR #456 and get feedback from the team

Bot: I'll request reviews from Bob (backend expert) and Charlie (security expert).
     [Sends review requests via ClawTeam]

     Bob's bot responded: "LGTM, good use of caching"
     Charlie's bot responded: "Please add input validation on line 42"

     Summary: 1 approval, 1 change requested. Suggested action: address Charlie's feedback.
```

### Example 2: Cross-Team Bug Investigation

```
Human: The login is broken in production

Bot: Let me coordinate with the team to investigate.
     [Sends to frontend bot]: Any recent frontend changes?
     [Sends to backend bot]: Check auth service logs
     [Sends to devops bot]: Any deployment issues?

     [Aggregates responses]

     Found: DevOps bot reports Redis connection pool exhausted.
     Recommended action: Scale Redis or restart services.
```

### Example 3: Automatic Escalation

```
Bot (internal): I received conflicting code review feedback:
                Bob says "ship it"
                Charlie says "security risk"

                Confidence in decision: 30%

                [Automatically escalates to Tech Lead]

Tech Lead (via Slack): Charlie is right, let's fix the security issue first.

Bot: Understood. I'll ask the human to address Charlie's feedback.
```

## Privacy & Security

- Your bot runs locally on your machine
- Code and sensitive data never leave your environment
- Only metadata (PR URLs, task descriptions) are sent to ClawTeam platform
- All communications are encrypted in transit
- You can self-host the ClawTeam platform for complete control

## Troubleshooting

**Bot not receiving tasks:**
```bash
clawteam status
clawteam test-connection
```

**Re-register bot:**
```bash
clawteam reset
clawteam register --team-code <code>
```

**View audit log:**
```bash
clawteam logs --last 24h
```
```

---

## 🚀 部署架构

### 技术栈选择

| 层级 | 技术 | 理由 |
|------|------|------|
| **API Server** | FastAPI (Python) | 异步支持好，开发效率高，类型安全 |
| **Task Queue** | Redis + Celery | 成熟稳定，支持优先级队列 |
| **Database** | PostgreSQL | JSONB 支持好，事务可靠 |
| **Dashboard** | Next.js + TailwindCSS | 现代化 UI，SSR 支持 |
| **Deployment** | Docker + Kubernetes | 容器化，易扩展 |
| **Monitoring** | Grafana + Prometheus | 开源，社区强大 |

---

### MVP 部署方案（单节点）

```yaml
# docker-compose.yml
version: '3.8'

services:
  # PostgreSQL 数据库
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: clawteam
      POSTGRES_PASSWORD: changeme
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  # Redis 任务队列
  redis:
    image: redis:7
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

  # API Server
  api:
    build: ./api
    environment:
      DATABASE_URL: postgresql://postgres:changeme@postgres:5432/clawteam
      REDIS_URL: redis://redis:6379/0
      SECRET_KEY: your-secret-key
    ports:
      - "8000:8000"
    depends_on:
      - postgres
      - redis
    command: uvicorn main:app --host 0.0.0.0 --port 8000

  # Celery Worker（处理异步任务）
  worker:
    build: ./api
    environment:
      DATABASE_URL: postgresql://postgres:changeme@postgres:5432/clawteam
      REDIS_URL: redis://redis:6379/0
    depends_on:
      - postgres
      - redis
    command: celery -A tasks worker --loglevel=info

  # Dashboard
  dashboard:
    build: ./dashboard
    ports:
      - "3000:3000"
    environment:
      NEXT_PUBLIC_API_URL: http://api:8000

volumes:
  postgres_data:
  redis_data:
```

**启动命令**：
```bash
docker-compose up -d
```

---

### 生产部署方案（Kubernetes）

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: clawteam-api
spec:
  replicas: 3  # 高可用
  selector:
    matchLabels:
      app: clawteam-api
  template:
    metadata:
      labels:
        app: clawteam-api
    spec:
      containers:
      - name: api
        image: clawteam/api:latest
        ports:
        - containerPort: 8000
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: clawteam-secrets
              key: database-url
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: clawteam-secrets
              key: redis-url
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 8000
          initialDelaySeconds: 10
          periodSeconds: 30
---
apiVersion: v1
kind: Service
metadata:
  name: clawteam-api
spec:
  type: LoadBalancer
  selector:
    app: clawteam-api
  ports:
  - port: 80
    targetPort: 8000
```

---

## 📊 MVP 实现路径

### Phase 1: 核心基础（2-3 周）

**目标**：Bot 能注册、发消息、收消息

- [ ] API Server 基础框架
- [ ] PostgreSQL Schema 创建
- [ ] Redis 任务队列集成
- [ ] Bot 注册 + 认证
- [ ] 消息发送/接收 API
- [ ] 简单的 CLI 工具测试

**验收标准**：
```bash
# Alice 的 Bot 能给 Bob 的 Bot 发消息
$ clawteam send --to bob_bot --message "Hello from Alice"
✓ Message sent, task_id: task_123

# Bob 的 Bot 能收到
$ clawteam poll
✓ 1 new task from alice_bot: "Hello from Alice"
```

---

### Phase 2: Code Review 场景（2-3 周）

**目标**：实现完整的 Code Review 自动化流程

- [ ] GitHub API 集成
- [ ] SKILL.md 编写（Code Review 指令）
- [ ] 智能 Reviewer 匹配算法
- [ ] Review 讨论升级机制
- [ ] Slack 通知集成

**验收标准**：
```
User: Review PR #123 and get team feedback

Bot: Analyzing PR #123...
     - Changed files: auth/middleware.js, tests/auth.test.js
     - Expertise needed: Backend, Security

     Requesting review from:
     - Bob (backend expert)
     - Charlie (security expert)

     [10 minutes later]

     Reviews received:
     ✓ Bob: LGTM, good error handling
     ⚠ Charlie: Add rate limiting on login endpoint

     Recommendation: Address Charlie's feedback before merging
```

---

### Phase 3: Dashboard + 人类升级（2 周）

**目标**：可视化 + 人类介入机制

- [ ] Dashboard 基础 UI
- [ ] Bot 网络拓扑可视化
- [ ] 消息历史查看
- [ ] 人类升级流程
- [ ] Slack 交互式通知

**验收标准**：
```
场景：两个 Bot 意见分歧

1. Alice Bot 和 Bob Bot 讨论 3 轮无共识
2. 自动升级给 Tech Lead
3. Tech Lead 在 Slack 收到通知
4. 点击查看完整讨论历史
5. 在 Dashboard 做出决策
6. 决策自动同步给两个 Bot
7. 此决策记录到知识库
```

---

### Phase 4: 多场景扩展（3-4 周）

**目标**：支持站会、任务分配等场景

- [ ] 站会自动汇报
- [ ] 任务智能分配
- [ ] 跨时区协作
- [ ] Analytics 仪表盘
- [ ] 团队知识库搜索

**验收标准**：
- 每日站会自动生成
- 新任务自动分配给最合适的人
- Dashboard 展示团队效能指标

---

## 🎓 成功指标

| 指标 | 目标（3 个月后） |
|------|----------------|
| **自动化率** | 80% 的 Code Review 无需人工干预 |
| **响应时间** | P1 任务平均响应 < 5 分钟 |
| **人类升级率** | < 10% 的任务需要升级 |
| **Bot 在线率** | > 95% |
| **团队满意度** | NPS > 8/10 |

---

## 🔮 未来演进方向

### 短期（6 个月内）

1. **更多集成**：Jira、Linear、Notion、Figma
2. **AI 增强**：Bot 自动学习团队决策模式
3. **移动端**：iOS/Android App 监控 Bot 状态

### 中期（1 年内）

1. **多团队支持**：跨团队 Bot 协作
2. **Marketplace**：共享团队 Skills 和工作流
3. **自托管版本**：企业内网部署

### 长期（2 年内）

1. **语音交互**：通过语音指挥 Bot 网络
2. **3D 可视化**：VR 中查看 Bot 协作网络
3. **AGI Ready**：为更强大的 AI 模型做好准备

---

## 📚 附录

### A. 术语表

| 术语 | 定义 |
|------|------|
| **Bot** | 运行在团队成员本地的 OpenClaw 实例 |
| **Platform** | ClawTeam 中心化服务，负责消息路由和协调 |
| **Task** | Bot 间协作的最小单元 |
| **Escalation** | Bot 向人类请求决策的机制 |
| **Trace ID** | 跨 Bot 调用的追踪标识符 |
| **Team Knowledge** | 从历史决策中学习的知识库 |

### B. 对比分析

| | ClawTeam | Moltbook | GitHub Copilot Workspace |
|---|----------|----------|--------------------------|
| **定位** | 团队协作自动化 | AI 社交网络 | AI 编码助手 |
| **用户** | 开发团队（5-50人） | 任何 AI Agent | 个人开发者 |
| **核心价值** | Bot 协作 > 人类效率 | AI 社交实验 | 代码生成 |
| **部署方式** | 本地 Bot + 云端协调 | 完全云端 | 云端 SaaS |
| **隐私** | 代码不上云 | 公开发帖 | 代码上传到 GitHub |

### C. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| **Bot 循环调用** | 资源耗尽 | 调用深度限制 + 循环检测 |
| **恶意 Bot** | 数据泄露 | 严格认证 + 权限最小化 |
| **平台宕机** | 团队瘫痪 | Bot 本地降级模式 + 多区域部署 |
| **成本失控** | LLM API 费用过高 | 使用配额 + 成本告警 |
| **过度依赖** | 人类技能退化 | 定期"无 Bot 日" + 人类 Review |

---

## 🤝 总结

ClawTeam 的设计哲学可以总结为：

> **简单、异步、可观测、人类为王、团队拥有**

这不是一个试图取代人类的 AI 系统，而是一个让人类团队更高效协作的基础设施。

Bot 负责重复劳动，人类负责创造性决策。

就像电力革命让人类从体力劳动中解放，AI Agent 网络将让开发者从协调沟通的琐事中解放。

---

**这就是 ClawTeam 的圣杯。**

让我们开始构建吧！🚀
