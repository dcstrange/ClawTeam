# OpenClaw 与 Claude Code 的关系

> ⚠️ Historical Notice: 本目录以背景资料/调研为主，不是当前实现规范。
> 当前规范请优先参考：`docs/spec/README.md` 与各域 canonical 文档。

> 两者常被混为一谈，但它们是定位完全不同的产品，因商标纠纷和生态博弈而交织在一起。

---

## 一、一句话概括

| | OpenClaw | Claude Code |
|--|---------|-------------|
| **本质** | 开源个人 AI 助手平台 | Anthropic 官方 AI 编码工具 |
| **定位** | 自动化日常生活与工作任务 | 在终端/IDE 中辅助软件开发 |
| **创始人** | Peter Steinberger（独立开发者） | Anthropic（公司产品） |
| **开源** | 100% 开源 | 闭源商业产品 |

---

## 二、名字的渊源 —— 为什么常被关联？

OpenClaw 最初的名字叫 **Clawdbot**，拆开来看就是 **Clawd + bot**。
"Clawd" 与 Anthropic 的 AI 品牌 "Claude" 谐音，这不是巧合——
项目最初正是以 Claude 模型为核心构建的，早期被社区称为"Claude with hands"
（长了手的 Claude）。

### 改名时间线

```
2025 年末    Clawdbot 发布（Clawd ≈ Claude 谐音致敬）
    │
2026.01.26  项目爆火，24h 斩获 9000 Star
    │
2026.01.27  Anthropic 发律师函，要求改名
    │          （Anthropic 的 Claude Code 吉祥物也叫 "Clawd"）
    │
    ├──→ 尝试协商改为 "Clawbot" → 被拒
    │
    ├──→ 改名为 "Moltbot"（Molt = 龙虾蜕壳）
    │     改名过程中释放旧账号，10 秒内被骗子抢注
    │     骗子用 @clawdbot 发了假加密货币，市值一度冲到 1600 万美元
    │
2026.01.28  最终定名为 "OpenClaw"
            Open（开源开放）+ Claw（龙虾爪，致敬起源）
```

---

## 三、核心区别对比

### 3.1 定位与使用场景

```
OpenClaw                              Claude Code
─────────────────────                 ─────────────────────
"你的全能个人助手"                      "你的编程搭档"

通过聊天指令完成：                      在终端/IDE 中完成：
 ├─ 管理日历和邮件                       ├─ 编写和重构代码
 ├─ 在线购物和订餐                       ├─ 调试和修复 Bug
 ├─ 控制智能家居                         ├─ 理解代码库
 ├─ 监控服务器和股价                     ├─ 执行 Git 操作
 ├─ 发社交媒体                           ├─ 运行测试
 └─ 打电话、值机 ...                     └─ 创建 PR ...
```

### 3.2 模型支持

| 维度 | OpenClaw | Claude Code |
|------|---------|-------------|
| 模型绑定 | **模型无关** — 可接入任何 LLM | **绑定 Claude** — 只能用 Anthropic 模型 |
| 支持的模型 | Claude / GPT / Llama / Mixtral / Qwen / KIMI / MiMo 等 | Claude Opus 4.5 / Sonnet / Haiku |
| 本地模型 | 支持（通过 Ollama） | 不支持 |

### 3.3 运行方式

| 维度 | OpenClaw | Claude Code |
|------|---------|-------------|
| 运行环境 | 本地守护进程，始终在线 | 按需启动的 CLI 工具 |
| 主动性 | 有心跳机制，可主动联系用户 | 被动响应，用户提问才回答 |
| 记忆 | 跨会话持久记忆 | 会话内上下文（项目级 CLAUDE.md） |
| 通信渠道 | WhatsApp / Telegram / Discord 等 | 终端 / VSCode / JetBrains |

### 3.4 能力范围

| 能力 | OpenClaw | Claude Code |
|------|---------|-------------|
| 代码编写 | 可以（通过 Skill） | 核心能力 |
| 文件操作 | 完整系统访问 | 项目目录内操作 |
| 浏览器控制 | 可以 | 不可以 |
| 网络请求 | 可以 | 有限（WebFetch） |
| Shell 命令 | 完整 shell 访问 | 沙箱内执行 |
| 日历/邮件 | 可以 | 不可以 |
| 语音通话 | 可以（通过 ElevenLabs/Vapi） | 不可以 |
| 智能家居 | 可以 | 不可以 |
| 购物/支付 | 可以（接入 1Password） | 不可以 |

---

## 四、两者的冲突与博弈

### 4.1 商标纠纷

Anthropic 的 Claude Code 工具的吉祥物也叫 "Clawd"（一只龙虾形象），
因此 Clawdbot 的名字与 Anthropic 的品牌直接冲突，触发了律师函。

### 4.2 OAuth 封禁事件

2026 年 1 月 9 日，Anthropic **毫无预告地封堵了第三方工具通过 OAuth 登录
使用 Claude 的通道**，更新 API 以识别并拒绝来自第三方客户端的请求。

这意味着：
- OpenClaw 用户如果使用 Claude 作为模型，可能会被封禁
- Anthropic 正在积极封禁使用 Claude 凭证驱动 OpenClaw 的用户
- 这违反了 Anthropic 服务条款中的相关条款

**社区反应**: 开发者警告"他们迟早会后悔这个决定"。这一事件也间接推动了
OpenClaw 转向模型无关的定位，以及其他开源替代品（如 OpenCode）的崛起。

### 4.3 竞合关系

```
        Anthropic
       ┌────┴────┐
       │         │
  Claude API   Claude Code
       │         │
       │    (商标冲突 + OAuth 封禁)
       │         │
       └────┬────┘
            │
            ▼
        OpenClaw
     (从依赖 → 独立)
     模型无关化转型
```

OpenClaw 与 Anthropic 的关系经历了三个阶段：
1. **致敬依赖期**: 名字叫 Clawdbot，核心用 Claude 模型
2. **冲突对抗期**: 律师函 + OAuth 封禁 + 改名风波
3. **独立发展期**: 改名 OpenClaw，定位模型无关基础设施

---

## 五、它们能协作吗？

可以。社区已有人将 Claude Code 作为 OpenClaw 的一个 Skill 集成：

- [openclaw-claude-code-skill](https://github.com/Enderfga/openclaw-claude-code-skill)：
  通过 MCP 将 Claude Code 的编码能力接入 OpenClaw

这样的架构是：
```
OpenClaw (个人助手层)
    │
    ├── Claude Code Skill (编码能力)
    ├── 日历 Skill
    ├── 邮件 Skill
    └── 其他 Skills ...
```

用户通过 OpenClaw 的聊天界面就可以同时驱动编码和日常自动化任务。

---

## 六、总结

| 维度 | 关系描述 |
|------|---------|
| **产品类型** | 完全不同：个人助手 vs 编码工具 |
| **名字渊源** | Clawdbot = Claude 谐音致敬，后因商标纠纷改名 |
| **模型关系** | 从依赖 Claude → 模型无关 |
| **商业关系** | Anthropic 视为商标侵权 + 违反 ToS |
| **技术协作** | 可通过 MCP/Skill 互相集成 |
| **社区定位** | OpenClaw = "长了手脚的 AI"，Claude Code = "懂代码的 AI" |

**一句话总结**: OpenClaw 最初是"致敬 Claude 的开源项目"，现在已蜕变为
一个独立的、模型无关的 AI 助手平台，与 Claude Code 在定位上互补而非竞争。

---

## 参考来源

- [OpenClaw - Wikipedia](https://en.wikipedia.org/wiki/OpenClaw)
- [OpenClaw：一个意外爆红的 AI 助手如何改写开源规则 - 掘金](https://juejin.cn/post/7601044684774506534)
- [From Moltbot to OpenClaw: When the Dust Settles - DEV Community](https://dev.to/sivarampg/from-moltbot-to-openclaw-when-the-dust-settles-the-project-survived-5h6o)
- [From Clawdbot to Moltbot: How a C&D Took Down the Internet's Hottest AI Project - DEV Community](https://dev.to/sivarampg/from-clawdbot-to-moltbot-how-a-cd-crypto-scammers-and-10-seconds-of-chaos-took-down-the-4eck)
- [Anthropic突禁第三方调用Claude引争议 - CSDN](https://blog.csdn.net/csdnnews/article/details/156915726)
- [OpenClaw Security Nightmare - Cisco Blogs](https://blogs.cisco.com/ai/personal-ai-agents-like-openclaw-are-a-security-nightmare)
- [From ClawBot to OpenClaw: The Evolution - SurferCloud](https://www.surfercloud.com/blog/from-clawbot-to-openclaw-the-evolution-of-a-personal-ai-giant)
- [openclaw-claude-code-skill - GitHub](https://github.com/Enderfga/openclaw-claude-code-skill)
