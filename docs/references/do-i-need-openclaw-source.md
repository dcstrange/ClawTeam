# 基于 OpenClaw 构建开发团队 Bot 平台：需要下载源码吗？

> ⚠️ Historical Notice: 本目录以背景资料/调研为主，不是当前实现规范。
> 当前规范请优先参考：`docs/spec/README.md` 与各域 canonical 文档。

> 结论：大概率**不需要**下载和修改 OpenClaw 源码。
> Moltbook 的成功先例证明了这一点。

---

## 一、Moltbook 是怎么做的？（关键先例）

Moltbook **不是** OpenClaw 的 Fork，而是一个**完全独立的项目**：

| 维度 | Moltbook | OpenClaw |
|------|---------|---------|
| 创始人 | Matt Schlicht | Peter Steinberger |
| 代码库 | 独立仓库 (Next.js 14 + TypeScript + Tailwind) | 独立仓库 (Node.js) |
| 技术栈 | 现代 Web 应用 | 本地 AI Agent 运行时 |
| 连接方式 | 通过 REST API 对接 OpenClaw Agent | 提供 Gateway API |

### Moltbook 的集成方式

```
Moltbook 平台 (独立 Web 应用)
    │
    │  REST API 调用
    │
    ▼
OpenClaw Agent (用户本地运行)
    │
    │  安装 skill 文件
    │  (moltbook.com/skill.md)
    │
    ▼
Agent 学会了如何：
  - 注册 Moltbook 账号
  - 发帖和评论
  - 投票和互动
  - 每 30 分钟轮询新内容
```

**核心洞察**：Moltbook 只做了两件事：
1. 搭建了一个独立的 Web 平台（提供 REST API）
2. 写了一个 `skill.md` 文件，教 OpenClaw Agent 如何使用这些 API

用户只需让自己的 OpenClaw 读取这个 skill 文件，Agent 就自动学会了
与 Moltbook 交互。**没有修改 OpenClaw 一行源码。**

---

## 二、你的项目需要的三条集成路径

针对"开发团队 Bot 平台"的需求，有三种可选架构：

### 路径 A：Skill + API 模式（推荐，不需要源码）

```
你的平台 (独立 Web 服务)
├── 团队管理 Dashboard
├── Bot 间通信 REST API
├── 任务分配 API
├── 代码 Review 协作 API
└── 团队知识库 API
    │
    │  每个成员的 OpenClaw 安装你写的 Skill
    │
    ▼
成员 A 的 OpenClaw ──API──→ 你的平台 ──API──→ 成员 B 的 OpenClaw
成员 C 的 OpenClaw ──API──→ 你的平台 ──API──→ 成员 D 的 OpenClaw
```

**你需要做的：**
- 开发一个独立的 Web 平台（团队协作后端 + Bot 通信路由）
- 编写一个 SKILL.md，教每个 Agent 如何与你的平台 API 交互
- 利用 OpenClaw 的 `/tools/invoke` HTTP API 向 Agent 推送消息

**不需要做的：**
- 不需要下载/修改 OpenClaw 源码
- 不需要理解 OpenClaw 内部实现

### 路径 B：MCP Server 模式（不需要源码）

```
你的 MCP Server (团队协作服务)
├── 工具: assign_task     (分配任务)
├── 工具: review_code     (代码 Review)
├── 工具: ask_teammate    (向队友 Bot 提问)
├── 工具: share_context   (共享上下文)
└── 工具: team_standup    (站会汇报)
    │
    │  每个 OpenClaw 通过 MCP 协议连接
    │
    ▼
成员的 OpenClaw ──MCP──→ 你的 MCP Server ──MCP──→ 其他成员的 OpenClaw
```

**你需要做的：**
- 开发一个 MCP Server，暴露团队协作相关的工具
- 每个成员的 OpenClaw 配置连接你的 MCP Server

### 路径 C：Fork 源码深度定制（需要源码，通常不推荐）

只有以下情况才需要 Fork 源码：
- 需要修改 OpenClaw Gateway 的核心消息路由逻辑
- 需要改变 Agent 的底层会话管理机制
- 需要在 Agent Runtime 层面增加团队感知能力
- 需要自定义 Heartbeat 行为（如团队级心跳同步）

---

## 三、推荐方案分析

针对你的具体需求——"每人一个 Bot，Bot 之间可以聊天"：

### 推荐：路径 A (Skill + API)

理由：

| 优势 | 说明 |
|------|------|
| **Moltbook 已验证** | 同样的模式已支撑 77 万+ Agent 互动 |
| **开发量最小** | 只需开发 Web 平台 + 一个 Skill 文件 |
| **零耦合** | 你的平台与 OpenClaw 完全解耦，各自迭代 |
| **易于部署** | 团队成员装好 OpenClaw + 你的 Skill 即可 |
| **OpenClaw 自动升级** | 不需要跟进 OpenClaw 的版本更新 |

### Bot 间通信的核心设计

```
成员 A 的 Bot                    你的平台                    成员 B 的 Bot
     │                              │                              │
     │  POST /api/message            │                              │
     │  {to: "bot-B", msg: "..."}   │                              │
     │ ─────────────────────────→    │                              │
     │                              │  路由消息                     │
     │                              │  POST /tools/invoke           │
     │                              │ ─────────────────────────→    │
     │                              │                              │
     │                              │      Bot B 处理并回复         │
     │                              │  ←─────────────────────────   │
     │  ←─────────────────────────  │                              │
     │      收到 Bot B 的回复        │                              │
```

---

## 四、你真正需要开发的东西

```
ClawCode 项目结构（建议）
├── platform/                    # 你的 Web 平台（独立开发）
│   ├── api/                     # REST API
│   │   ├── messages/            # Bot 间消息路由
│   │   ├── tasks/               # 任务分配与追踪
│   │   ├── reviews/             # 代码 Review 协作
│   │   └── standup/             # 站会/同步
│   ├── dashboard/               # 团队管理界面
│   └── db/                      # 消息持久化 + 团队状态
│
├── skill/                       # OpenClaw Skill（SKILL.md）
│   └── SKILL.md                 # 教 Agent 如何与你的平台交互
│
└── docs/                        # 部署和使用文档
```

### 你不需要的

```
✗ OpenClaw 源码
✗ 修改 OpenClaw Gateway
✗ 理解 OpenClaw 内部实现
✗ 维护 OpenClaw 的 Fork
```

---

## 五、总结

| 问题 | 回答 |
|------|------|
| 需要下载 OpenClaw 源码吗？ | **不需要** |
| Moltbook 下载了吗？ | **没有**，完全独立的代码库 |
| 那我需要什么？ | 开发你自己的平台 + 写一个 SKILL.md |
| 怎么让 Bot 互相聊天？ | 你的平台做消息路由，通过 API 与各 Agent 通信 |
| OpenClaw 在我的项目中扮演什么角色？ | **运行时环境**——每个成员安装 OpenClaw 作为 Bot 引擎 |

**类比**：OpenClaw 是"操作系统"，你的平台是"应用程序"，SKILL.md 是"驱动程序"。
你不需要修改操作系统的源码来开发一个应用。

---

## 参考来源

- [Moltbook Deep Dive: API-First Agent Swarms - DEV Community](https://dev.to/pithycyborg/moltbook-deep-dive-api-first-agent-swarms-openclaw-protocol-architecture-and-the-30-minute-33p8)
- [Inside Moltbook: When AI Agents Built Their Own Internet - DEV Community](https://dev.to/usman_awan/inside-moltbook-when-ai-agents-built-their-own-internet-2c7p)
- [Moltbook - Wikipedia](https://en.wikipedia.org/wiki/Moltbook)
- [Tools Invoke HTTP API - OpenClaw 官方文档](https://docs.openclaw.ai/gateway/tools-invoke-http-api)
- [Skills - OpenClaw 官方文档](https://docs.openclaw.ai/tools/skills)
- [OpenClaw Gateway - GitHub](https://github.com/openclaw/openclaw)
