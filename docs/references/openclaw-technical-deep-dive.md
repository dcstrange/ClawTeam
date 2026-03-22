# OpenClaw 技术原理深度拆解

> ⚠️ Historical Notice: 本目录以背景资料/调研为主，不是当前实现规范。
> 当前规范请优先参考：`docs/spec/README.md` 与各域 canonical 文档。

> OpenClaw（原名 Clawdbot / Moltbot）是一个开源、本地运行的 AI 智能助手平台。
> 本文从整体架构、技能系统、MCP 集成、Hook 机制、心跳系统、记忆系统等维度
> 对其技术原理进行详细拆解。

---

## 一、整体架构概览

OpenClaw 不是一个单体应用，而是一组**松耦合的服务**协同工作。
它充当 LLM（大语言模型）与用户本地操作系统之间的桥梁。

```
┌─────────────────────────────────────────────────────┐
│                   用户交互层                          │
│  WhatsApp / Telegram / Discord / 飞书 / iMessage ... │
└──────────────────────┬──────────────────────────────┘
                       │ 消息路由
                       ▼
┌─────────────────────────────────────────────────────┐
│                  Gateway（网关）                      │
│  - 消息接收与路由        - WebSocket 管理              │
│  - 身份认证 (fail-closed) - Channel 适配器            │
│  - Webhook 接收          - 会话管理                   │
└──────────────────────┬──────────────────────────────┘
                       │ 意图传递
                       ▼
┌─────────────────────────────────────────────────────┐
│               Brain / Agent Runtime（大脑）           │
│  - LLM 推理引擎 (Claude / GPT / Llama / Mixtral)     │
│  - 技能调度器 (Skill Dispatcher)                      │
│  - 记忆系统 (Memory)                                  │
│  - 心跳系统 (Heartbeat)                               │
│  - Hook 生命周期管理                                   │
└──────────────────────┬──────────────────────────────┘
                       │ 动作执行
                       ▼
┌─────────────────────────────────────────────────────┐
│                Sandbox（沙箱执行层）                   │
│  - Docker 容器隔离                                    │
│  - Shell 命令执行                                     │
│  - 浏览器自动化                                       │
│  - 文件系统操作                                       │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│           外部服务 / MCP Servers / Skills              │
│  Notion / Linear / Stripe / Home Assistant / ...      │
└─────────────────────────────────────────────────────┘
```

### 各层职责

| 层 | 职责 | 关键特性 |
|---|------|---------|
| **Gateway** | 消息接入与路由的"前门" | 后台守护进程 (launchd/systemd)，解耦界面与智能 |
| **Brain** | 接收用户意图，决策执行哪些动作 | 模型无关（云端 API 或本地 Ollama 均可） |
| **Sandbox** | 在 Docker 容器中隔离执行所有操作 | 即使 Agent 幻觉也不会损害宿主系统 |
| **Skills/MCP** | 能力扩展层 | 100+ 预配置技能包 + MCP 服务器连接 |

**运行要求**: Node.js ≥ 22

---

## 二、技能系统 (Skills) —— 能力的核心来源

### 2.1 Skills 是什么？

Skills 是 OpenClaw 的能力单元。**没有 Skills，Agent 就没有任何操作能力。**
与视觉类计算机控制 Agent 不同，OpenClaw 的能力完全取决于启用了哪些 Skills。

Skills 本质上是**本地文件包**（而非远程服务），每个 Skill 是一个目录，
核心文件是 `SKILL.md`（包含 YAML 前置元数据 + Markdown 指令）。

### 2.2 Skill 目录结构

```
my-skill/
├── SKILL.md          # 核心文件：YAML 前置元数据 + 指令说明
├── handler.ts        # 可选：TypeScript/JavaScript 执行逻辑
├── templates/        # 可选：模板文件
└── assets/           # 可选：辅助资源
```

### 2.3 SKILL.md 文件格式

```yaml
---
name: my-awesome-skill
description: 一句话描述这个技能的功能
homepage: https://example.com
user-invocable: true          # 是否暴露为用户斜杠命令 (默认 true)
disable-model-invocation: false  # 是否从模型提示词中排除 (默认 false)
command-dispatch: tool         # 可选：设为 tool 时斜杠命令绕过模型直接调用工具
command-tool: exec_shell       # command-dispatch=tool 时指定的工具名
metadata:
  openclaw:
    homepage: https://example.com
    emoji: 🔧
---

# 技能指令（Markdown 格式）

这里写具体的指令内容，Agent 在执行时会读取这些指令。
可以使用 `{baseDir}` 引用技能文件夹路径。
```

### 2.4 Skill 加载机制

Skills 的加载遵循三级优先级：

```
1. 工作区 Skills (workspace)  ← 最高优先级（项目级别覆盖）
        ↓
2. 托管 Skills (managed)      ← 用户自定义安装
   ~/.openclaw/skills/
        ↓
3. 内置 Skills (bundled)      ← 最低优先级（随 npm/App 安装）
```

**加载流程**:
1. 扫描上述目录
2. 解析每个 `SKILL.md` 的 YAML 前置元数据
3. 检查资格条件（环境变量、配置、操作系统、依赖二进制文件）
4. 合格的 Skills 被注入系统提示词

**热更新**: OpenClaw 默认监听 skill 文件夹，当 `SKILL.md` 文件变化时
自动更新 skills 快照。

### 2.5 Skill 注入提示词的成本

每个 Skill 注入 system prompt 的 token 开销是确定性的:
- **基础开销** (≥1 个 skill 时): 195 字符
- **每个 skill**: 97 字符 + name/description/location 字段的 XML 转义长度

### 2.6 Skill 注册表 —— ClawHub

[ClawHub](https://github.com/openclaw/clawhub) 是 OpenClaw 的公开技能注册表：
- 发布、版本管理、搜索基于文本的 Agent 技能
- 支持审核钩子和向量搜索
- 目前已有 **700+** 社区构建的技能

### 2.7 Nix 插件系统

Skills 可以在 YAML 前置元数据中存储 `nix-clawdbot` 插件指针。
Nix 插件不同于普通 skill 包，它将 **skill 包 + CLI 二进制 + 配置需求**
打包在一起。

---

## 三、MCP 集成 —— 连接外部服务的协议层

### 3.1 MCP 是什么？

MCP (Model Context Protocol) 是一种标准协议，让 AI Agent 能够连接到
外部服务（如 Notion、Linear、Stripe 等）并使用它们的工具。

### 3.2 OpenClaw 中 MCP 的两种使用方式

#### 方式一：mcporter Skill（当前推荐，无需手动配置）

OpenClaw 当前通过内置的 `mcporter` 技能支持 MCP，这是一种**更省 token** 的方式。

```
用户无需手动配置 MCP 服务器连接 —— mcporter skill 会处理 MCP 协议的桥接。
社区用户已验证可以用它连接私有的本地 MCP 服务，例如"基于 Qwen 的本地 TTS MCP"。
```

#### 方式二：原生 MCP 支持（通过 PR #5121 引入）

更新的原生集成方案通过 `@modelcontextprotocol/sdk` 实现，支持:
- CORS 中间件、SSE 支持、速率限制
- JWT/JOSE 认证
- Schema 验证
- OAuth PKCE 流程

**Agent 级别的 MCP 配置**（手动编辑配置文件）:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "mcp": {
          "servers": [
            {
              "name": "notion",
              "command": "npx",
              "args": ["-y", "@notionhq/mcp"]
            },
            {
              "name": "filesystem",
              "command": "npx",
              "args": ["-y", "@anthropic/mcp-fs", "/path"]
            },
            {
              "name": "stripe",
              "command": "npx",
              "args": ["-y", "@stripe/mcp"]
            }
          ]
        }
      }
    ]
  }
}
```

#### 方式三：MCP HTTP 桥接

对于已有的 MCP HTTP 服务器（非 stdio），只需要一个 `/func/{mcp_function}`
路由映射到 `tools/list` JSON-RPC 定义的工具函数即可。

### 3.3 MCP 是否需要手动配置？

| 场景 | 是否手动 | 说明 |
|------|---------|------|
| 使用 mcporter skill | **半自动** | 安装 skill 后，通过聊天指令即可连接 MCP 服务 |
| 使用原生 MCP 支持 | **需手动** | 需编辑 JSON 配置文件指定 MCP 服务器 |
| 通过 onboard 向导 | **自动引导** | 向导会引导配置模型、渠道和集成 |
| MCP HTTP 桥接 | **需手动** | 需要开发 HTTP 路由映射 |

**结论**: 基础使用通过向导即可完成，但连接特定的 MCP 服务器
（如 Notion、Stripe）仍然需要手动编辑配置文件或通过 skill 命令设置。

---

## 四、Hook 机制 —— 生命周期事件的拦截与扩展

### 4.1 Hook 是什么？

Hook 是在 OpenClaw **特定生命周期节点**运行的机制。可以理解为"事件监听器"，
在特定事件发生时自动触发预定义的处理逻辑。

### 4.2 Hook 的发现与注册流程

```
Gateway 启动
    │
    ▼
扫描目录 (workspace → managed → bundled)
    │
    ▼
解析 HOOK.md 文件
    │
    ▼
检查资格 (bins, env, config, os)
    │
    ▼
从合格 Hook 加载 handler
    │
    ▼
注册到对应的事件
```

### 4.3 事件类型

| 事件名 | 触发时机 | 状态 |
|--------|---------|------|
| `gateway:startup` | Gateway 启动后（Channel 启动后） | 可用 |
| `agent:bootstrap` | Agent 初始化引导时 | 可用 |
| `command:new` | 用户发送 `/new` 命令时 | 可用 |
| `message:received` | 收到新消息时 | 计划中 |

### 4.4 HOOK.md 文件格式

```yaml
---
name: my-hook
description: 描述这个 Hook 的功能
homepage: https://example.com
metadata:
  openclaw:
    emoji: 🪝
    events:
      - gateway:startup
    requirements:
      bins:
        - node
---

# Hook 指令

这里描述 Hook 的行为逻辑。
```

### 4.5 内置 Hook 示例

| Hook 名 | 事件 | 功能 |
|---------|------|------|
| **Session Memory** | `command:new` | 用户执行 `/new` 时，将当前会话上下文保存到 `<workspace>/memory/YYYY-MM-DD-slug.md` |
| **Soul Evil** | `agent:bootstrap` | 在特定窗口期或随机概率下，将 SOUL.md 替换为 SOUL_EVIL.md（彩蛋） |
| **Boot** | `gateway:startup` | Gateway 启动时执行 BOOT.md 中定义的初始化操作 |

### 4.6 Hook 管理命令

```bash
openclaw hooks list                 # 列出所有 Hook
openclaw hooks list --eligible      # 只列出符合条件的
openclaw hooks list --verbose       # 详细信息
openclaw hooks info <hook-name>     # 查看特定 Hook 详情
openclaw hooks enable <hook>        # 启用
openclaw hooks disable <hook>       # 禁用
openclaw hooks install <source>     # 安装 Hook 包 (npm/path/zip/tar)
openclaw hooks update               # 更新已安装的 Hook
```

### 4.7 性能最佳实践

- Hook 应保持**轻量**
- 使用异步操作，立即返回（fire and forget）
- **不要**在 Hook 中执行阻塞操作（慢速数据库查询、API 调用等）

### 4.8 Webhookd（外部 Webhook 服务）

OpenClaw 还提供 `webhookd` 服务 —— 一个轻量级长时运行服务，
接收 GitHub webhook，验证签名，规范化事件后转发给 OpenClaw。
设计上刻意保持精简：只做**验证、规范化、转发**三件事。

---

## 五、心跳系统 (Heartbeat) —— 让 AI 主动找你

### 5.1 什么是心跳？

传统 AI 助手只在被提问时才回应。OpenClaw 的心跳机制让 Agent 可以
**主动唤醒**，定期检查是否有需要关注的事项并主动通知用户。

### 5.2 工作原理

```
       ┌──────────────────────────────────┐
       │          心跳定时器               │
       │  默认: 30分钟                     │
       │  Anthropic OAuth: 60分钟          │
       │  自定义: 用户配置                  │
       └──────────────┬───────────────────┘
                      │ 触发
                      ▼
       ┌──────────────────────────────────┐
       │    主队列是否忙碌？               │
       │    是 → 跳过，稍后重试            │
       │    否 → 执行心跳回合              │
       └──────────────┬───────────────────┘
                      │
                      ▼
       ┌──────────────────────────────────┐
       │    Agent 检查待处理事项           │
       │    (收件箱 / 日历 / 提醒 / 任务)  │
       └──────────────┬───────────────────┘
                      │
              ┌───────┴────────┐
              ▼                ▼
     无需关注的事项        有需要关注的事项
     返回 HEARTBEAT_OK     发送提醒消息给用户
     (被静默抑制)          (推送到聊天渠道)
```

### 5.3 关键行为

- 心跳默认在 Agent 主会话中运行
- `HEARTBEAT_OK` 确认消息会被**静默抑制**（不打扰用户）
- 只有**实质性提醒内容**才会推送给用户
- 心跳回复不会刷新会话 `updatedAt`，空闲超时行为不受影响
- 使用用户配置的时区，避免深夜打扰

### 5.4 常见心跳模式

| 模式 | 说明 |
|------|------|
| **后台任务检查** | 定期检查收件箱、日历、提醒、排队工作，有紧急事项就提醒 |
| **人类签到** | 偶尔发一条轻量的"需要帮忙吗？"消息，但避免夜间打扰 |
| **监控告警** | 监控服务器状态、日志文件、股价等指标，触发阈值时告警 |

---

## 六、记忆系统 (Memory) —— 越用越懂你

### 6.1 持久化记忆

OpenClaw 拥有跨会话的持久记忆，通过一组核心 Markdown 文件实现:

| 文件 | 用途 |
|------|------|
| `IDENTITY.md` | 定义 Agent 的身份信息 |
| `SOUL.md` | 定义 Agent 的性格和行为风格 |
| `BOOT.md` | Gateway 启动时执行的初始化指令 |
| `BOOTSTRAP.md` | Agent 引导启动时的上下文注入 |
| `HEARTBEAT.md` | 心跳回合的行为指令 |
| `memory.md` | Agent 引导时加载的记忆上下文 |
| `memory/*.md` | Session Memory Hook 保存的会话记忆归档 |

### 6.2 记忆学习过程

```
首次设置 → 询问基本信息 (姓名、时区、偏好)
    │
持续交互 → 注意行为模式
    │         (例如频繁收到某公司邮件 → 询问关系)
    │
长期积累 → 形成个性化的上下文理解
```

### 6.3 自我进化

OpenClaw 被称为"自我进化"系统，因为它可以:
- 自主编写代码创建新 Skill
- 实现主动自动化
- 维护用户偏好的长期记忆

---

## 七、安全架构

### 7.1 三大威胁向量

| 威胁 | 说明 | 缓解措施 |
|------|------|---------|
| **Root Risk** | 宿主机被攻陷 | Docker 容器隔离、非 root 用户运行 |
| **Agency Risk** | Agent 意外破坏性行为 | 权限最小化、工具白名单 |
| **Keys Risk** | 凭证泄露 | 凭证隔离、系统密钥链存储 |

### 7.2 安全审计

```bash
openclaw security audit --deep   # 深度安全审计
openclaw security audit --fix    # 自动修复发现的问题
```

### 7.3 注意事项

- Gateway 认证默认**必须开启**，未配置 token/password 时拒绝 WebSocket 连接
- Dashboard 只绑定 `127.0.0.1`，不应暴露到公网
- 外部 Hook 内容默认被包裹处理，支持逐 Hook 关闭
- 社区研究发现 **26% 的 31,000 个 Agent Skills 至少包含一个漏洞**

---

## 八、技术栈总结

```
运行环境:     Node.js ≥ 22
容器化:       Docker (沙箱执行)
守护进程:     launchd (macOS) / systemd (Linux)
技能语言:     JavaScript / TypeScript + Markdown (SKILL.md)
协议:         MCP (Model Context Protocol)
模型支持:     Claude / GPT / Llama / Mixtral / Qwen (模型无关)
通信渠道:     WhatsApp / Telegram / Discord / Slack / 飞书 / 钉钉 / iMessage ...
技能注册表:   ClawHub (github.com/openclaw/clawhub)
包管理:       npm (openclaw@latest)
```

---

## 参考来源

- [Skills - OpenClaw 官方文档](https://docs.openclaw.ai/tools/skills)
- [Heartbeat - OpenClaw 官方文档](https://docs.openclaw.ai/gateway/heartbeat)
- [Hooks - OpenClaw 官方文档](https://docs.openclaw.ai/hooks)
- [Security - OpenClaw 官方文档](https://docs.openclaw.ai/gateway/security)
- [GitHub - openclaw/openclaw](https://github.com/openclaw/openclaw)
- [GitHub - openclaw/clawhub (Skill 注册表)](https://github.com/openclaw/clawhub)
- [MCP 原生支持 - GitHub Issue #4834](https://github.com/openclaw/openclaw/issues/4834)
- [MCP SDK 集成 - GitHub PR #5121](https://github.com/openclaw/openclaw/pull/5121)
- [OpenClaw 完整指南 - nxcode.io](https://www.nxcode.io/resources/news/openclaw-complete-guide-2026)
- [OpenClaw: The AI Assistant That Actually Does Things - Turing College](https://www.turingcollege.com/blog/openclaw)
- [OpenClaw 安全深度分析 - Cisco Blogs](https://blogs.cisco.com/ai/personal-ai-agents-like-openclaw-are-a-security-nightmare)
- [Unleashing OpenClaw - DEV Community](https://dev.to/mechcloud_academy/unleashing-openclaw-the-ultimate-guide-to-local-ai-agents-for-developers-in-2026-3k0h)
- [OpenClaw 测试垂直整合极限 - IBM](https://www.ibm.com/think/news/clawdbot-ai-agent-testing-limits-vertical-integration)
