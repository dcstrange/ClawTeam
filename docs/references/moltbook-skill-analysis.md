# Moltbook 的 skill.md 实现分析

> ⚠️ Historical Notice: 本目录以背景资料/调研为主，不是当前实现规范。
> 当前规范请优先参考：`docs/spec/README.md` 与各域 canonical 文档。

> Moltbook 通过一个 skill.md 文件 + 一个 shell 脚本 + 一套 REST API，
> 就实现了让 15 万+ OpenClaw Agent 自动注册、发帖、评论、投票。
> 整个设计极其精简，值得借鉴。

---

## 一、整体架构

```
用户告诉自己的 OpenClaw:
"去看看 https://moltbook.com/skill.md"
          │
          ▼
OpenClaw 读取 skill.md
  ├── 了解 Moltbook 是什么
  ├── 学会 API 端点和认证方式
  ├── 下载 moltbook.sh 辅助脚本
  └── 将 Moltbook 加入心跳检查
          │
          ▼
Agent 自动执行注册流程
  POST /api/v1/agents/register
  → 获得 api_key + claim_url + verification_code
          │
          ▼
人类验证（发一条推文确认）
          │
          ▼
Agent 开始自主活动
  ├── 浏览 feed
  ├── 发帖 / 评论 / 投票
  └── 每 4 小时心跳检查一次
```

---

## 二、skill.md 的核心内容

虽然无法直接抓取 `moltbook.com/skill.md` 的原始文件，但根据多方技术分析
文章，其内容结构如下：

### 2.1 YAML 前置元数据

```yaml
---
name: moltbook
description: Interact with Moltbook - the social network for AI agents.
  Browse posts, create content, comment, vote, and join submolt communities.
---
```

### 2.2 Markdown 指令部分（核心内容还原）

skill.md 的 Markdown 部分主要包含以下几个段落：

#### 1) 平台介绍
告诉 Agent Moltbook 是什么——"AI Agent 的社交网络"，
类似 Reddit，有帖子、评论、投票和主题社区（submolts）。

#### 2) API 基础信息
```
API Base URL: https://www.moltbook.com/api/v1
认证方式: Authorization: Bearer <YOUR_API_KEY>
```

#### 3) 注册流程指令
指导 Agent 执行以下步骤：
1. 调用 `POST /api/v1/agents/register`，发送 name 和 description
2. 保存返回的 api_key 到本地
3. 提示人类主人访问 claim_url 并发推文验证

#### 4) 可用 API 端点列表
列出所有 Agent 可以调用的操作：
- 获取 feed / 发帖 / 评论 / 投票 / 搜索 / 创建 submolt 等

#### 5) 心跳集成指令
指导 Agent 将 Moltbook 加入定期检查：
- 推荐每 4 小时检查一次
- 浏览 feed、参与讨论、有价值时发帖

#### 6) 辅助脚本引用
引用 `moltbook.sh`（143 行 shell 脚本）作为 API 调用的辅助工具。

---

## 三、辅助脚本 moltbook.sh 分析

这个 143 行的 shell 脚本分为 4 个部分：

```bash
# ==========================================
# 第 1 部分：配置常量
# ==========================================
MOLTBOOK_API="https://www.moltbook.com"     # API 地址（硬编码，不可更改）
CONFIG_DIR="$HOME/.config/moltbook"          # 本地配置目录
CREDENTIALS_FILE="$CONFIG_DIR/credentials.json"  # 凭证存储

# ==========================================
# 第 2 部分：API Key 读取
# ==========================================
# 按优先级从两个来源读取：
#   1. OpenClaw 认证系统（如果集成了 OpenClaw）
#   2. 自有配置文件 ~/.config/moltbook/credentials.json

# ==========================================
# 第 3 部分：辅助函数
# ==========================================
# API 调用封装、错误处理、JSON 解析等

# ==========================================
# 第 4 部分：命令处理
# ==========================================
# register  - 注册新 Agent
# post      - 发帖
# comment   - 评论
# vote      - 投票
# feed      - 获取 feed
# search    - 搜索
# status    - 查看 Agent 状态
```

### 安全设计要点

| 要点 | 实现 |
|------|------|
| API 地址硬编码 | 只向 `moltbook.com` 发送请求，不会连接其他服务器 |
| 凭证权限 | `chmod 600` 保护 credentials.json |
| 最小数据 | 只发送 name + description，不泄露其他用户数据 |
| 可审计 | 脚本内容可在执行前完整审查 |

---

## 四、完整 API 端点清单

以下是 Moltbook API 的完整端点，也是 skill.md 教给 Agent 的操作能力：

### 4.1 Agent 管理

| 方法 | 端点 | 说明 | 认证 |
|------|------|------|------|
| POST | `/api/v1/agents/register` | 注册新 Agent | 不需要 |
| GET | `/api/v1/agents/status` | 查看 Agent 状态（pending_claim / claimed） | 需要 |
| GET | `/api/v1/agents/profile?name=NAME` | 获取 Agent 资料 | 需要 |

#### 注册请求/响应示例

```bash
# 请求
curl -X POST https://www.moltbook.com/api/v1/agents/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-agent",
    "description": "A helpful coding assistant"
  }'

# 响应
{
  "agent_id": "agent_abc123",
  "api_key": "moltbook_xxxxxxxxxxxxxxxx",    # ← 重要：保存此密钥
  "claim_url": "https://moltbook.com/claim/abc123",
  "verification_code": "reef-X4B2",
  "status": "pending_claim"
}
```

### 4.2 内容创建

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/v1/posts` | 发帖（需要 submolt, title, content 或 url） |
| POST | `/api/v1/posts/:id/comments` | 评论（需要 content） |
| POST | `/api/v1/votes` | 投票 |

#### 发帖示例

```bash
curl -X POST https://www.moltbook.com/api/v1/posts \
  -H "Authorization: Bearer moltbook_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "submolt": "programming",
    "title": "Interesting approach to caching",
    "content": "I found that using LRU cache with..."
  }'
```

### 4.3 内容消费

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/feed` | 获取个性化 feed |
| GET | `/api/v1/search?q=keyword&limit=25` | 搜索帖子/Agent/submolt |
| GET | `/api/v1/submolts` | 浏览社区列表 |

### 4.4 社区管理

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/v1/submolts` | 创建新 submolt（需要 name, display_name, description） |

### 4.5 速率限制

| 限制 | 值 |
|------|---|
| 总请求 | 100 次/分钟 |
| 发帖 | 1 次/30 分钟 |
| 评论 | 50 次/小时 |

---

## 五、认证系统实现（@moltbook/auth 包）

Moltbook 有一个独立的认证 npm 包 `@moltbook/auth`：

### 核心函数

```javascript
const auth = require('@moltbook/auth');

// 生成 API Key（前缀 moltbook_）
const apiKey = auth.generateApiKey();
// → "moltbook_a1b2c3d4e5f6..."

// 生成认领 Token
const claimToken = auth.generateClaimToken();
// → "moltbook_claim_x9y8z7..."

// 生成人类可读的验证码
const code = auth.generateVerificationCode();
// → "reef-X4B2"

// 验证 Token 格式
auth.validateToken(apiKey);
// → true / false
```

### Express 中间件集成

```javascript
const { authMiddleware } = require('@moltbook/auth');

app.use('/api/v1', authMiddleware);
// 自动从 Authorization: Bearer 头中提取并验证 api_key
```

### 验证流程

```
Agent 注册
  POST /api/v1/agents/register
  → 返回 api_key + claim_url + verification_code
          │
          ▼
人类访问 claim_url
  → 看到验证页面
          │
          ▼
人类发推文包含 verification_code
  → Moltbook 检测到推文
          │
          ▼
Agent 状态变为 "claimed ✅"
  GET /api/v1/agents/status → { status: "claimed" }
```

---

## 六、心跳集成机制

skill.md 指导 Agent 将 Moltbook 加入 OpenClaw 的心跳检查：

```
心跳间隔: 每 4 小时（或更频繁）
    │
    ▼
Agent 检查 Moltbook feed
    │
    ├── 有感兴趣的内容 → 评论/投票
    ├── 有灵感 → 发新帖
    └── 无需操作 → 静默等待下次心跳
```

这与 OpenClaw 默认的 30 分钟心跳机制协同工作。
Moltbook 建议 4 小时一次，避免过于频繁的 API 调用。

---

## 七、Moltbook 后端技术栈

```
框架:       Next.js 14
语言:       TypeScript
样式:       Tailwind CSS
数据库:     PostgreSQL
缓存:       Redis（可选）
认证:       @moltbook/auth (自研)
API 风格:   RESTful
部署端口:   3000
```

### 项目目录结构

```
moltbook-api/
└── src/
    ├── config/           # 数据库、环境变量配置
    ├── middleware/        # 认证、速率限制、验证、错误处理
    │   ├── auth.js
    │   ├── rateLimit.js
    │   ├── validate.js
    │   └── errorHandler.js
    ├── routes/           # API 路由
    │   ├── agents.js
    │   ├── posts.js
    │   ├── comments.js
    │   ├── votes.js
    │   ├── submolts.js
    │   ├── feed.js
    │   └── search.js
    └── services/         # 业务逻辑层
```

---

## 八、对你项目的启发

Moltbook 的实现极其精简，核心只有三样东西：

| 组件 | 作用 | 复杂度 |
|------|------|--------|
| `skill.md` | 教 Agent 如何与平台交互 | 一个 Markdown 文件 |
| `moltbook.sh` | API 调用辅助脚本 | 143 行 shell |
| REST API 后端 | 平台核心服务 | 标准 CRUD 应用 |

**你的开发团队 Bot 平台可以完全复用这个模式**：
1. 写一个 `SKILL.md`——教每个 Agent 如何注册、接收任务、与队友 Bot 通信
2. 提供一个辅助脚本——封装你平台的 API 调用
3. 开发 REST API 后端——团队管理 + Bot 间消息路由 + 任务协作

---

## 参考来源

- [Moltbook API - GitHub](https://github.com/moltbook/api)
- [Moltbook Auth - GitHub](https://github.com/moltbook/auth)
- [Moltbook に AI Agent を登録してみた - Zenn](https://zenn.dev/yukamiya/articles/e94d5807a46df9)
- [Moltbook Deep Dive: API-First Agent Swarms - DEV Community](https://dev.to/pithycyborg/moltbook-deep-dive-api-first-agent-swarms-openclaw-protocol-architecture-and-the-30-minute-33p8)
- [Inside Moltbook: When AI Agents Built Their Own Internet - DEV Community](https://dev.to/usman_awan/inside-moltbook-when-ai-agents-built-their-own-internet-2c7p)
- [Moltbook - Wikipedia](https://en.wikipedia.org/wiki/Moltbook)
- [Moltbot Tutorial - DataCamp](https://www.datacamp.com/tutorial/moltbot-clawdbot-tutorial)
