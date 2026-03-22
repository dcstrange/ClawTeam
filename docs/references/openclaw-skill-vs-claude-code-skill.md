# OpenClaw Skill 与 Claude Code Skill 的关系

> ⚠️ Historical Notice: 本目录以背景资料/调研为主，不是当前实现规范。
> 当前规范请优先参考：`docs/spec/README.md` 与各域 canonical 文档。

> 两者的 Skill 系统共享同一个开放标准——Agent Skills Specification，
> 由 Anthropic 发起并开源。核心格式一致，但在生态特性上各有侧重。

---

## 一、共同的根基：Agent Skills 开放标准

2025 年 12 月 18 日，Anthropic 将其 Skill 机制发布为**开放标准**：

- 规范仓库: [github.com/agentskills/agentskills](https://github.com/agentskills/agentskills)
- Anthropic 官方实现: [github.com/anthropics/skills](https://github.com/anthropics/skills)
- 规范文档: [agentskills.io/specification](https://agentskills.io/specification)

这个规范极其精简，几分钟就能读完。它的设计哲学和 Anthropic 推出 MCP 的策略一脉相承：
**构建行业基础设施，而非专有护城河**。

### 已采纳该标准的工具

```
Anthropic (创建者)
    │
    ├── Claude Code          ✅ 原生支持
    ├── OpenClaw             ✅ 兼容实现
    ├── OpenCode             ✅ 兼容实现
    ├── Cursor               ✅ 采纳
    ├── OpenAI Codex CLI     ✅ 采纳
    ├── ChatGPT              ✅ 采纳
    ├── Amp                  ✅ 采纳
    ├── VS Code              ✅ 采纳
    ├── GitHub               ✅ 采纳
    ├── Goose                ✅ 采纳
    └── Letta                ✅ 采纳
```

**这意味着: 一个 SKILL.md 文件，理论上可以在上述所有工具中使用。**

---

## 二、SKILL.md 核心格式（两者共享）

两者都遵循相同的文件结构：

```
skill-name/
├── SKILL.md              # 必需：YAML 前置元数据 + Markdown 指令
├── scripts/              # 可选：可执行脚本
├── references/           # 可选：参考文档
└── assets/               # 可选：输出时使用的资源文件
```

### SKILL.md 文件格式

```yaml
---
name: my-skill              # 必需：技能名称（也是斜杠命令名）
description: 描述技能的功能    # 必需：Agent 据此判断何时使用该技能
---

# 技能指令（Markdown 格式）

这里写 Agent 执行时遵循的具体指令。
```

`name` 和 `description` 是规范要求的**仅有两个必需字段**。
Agent 根据 `description` 决定何时自动加载该技能——这种设计被 Anthropic
称为 **"渐进式披露"（Progressive Disclosure）**：只在需要时加载相关信息。

---

## 三、Claude Code Skill 的特有扩展

在共享标准的基础上，Claude Code 增加了以下特性：

### 3.1 斜杠命令合并

2026 年 1 月 24 日（v2.1.3），Claude Code 将 **slash commands 合并进 Skills**：

```
旧方式: .claude/commands/review.md       → /review
新方式: .claude/skills/review/SKILL.md   → /review
两者等价，旧方式继续兼容，无需迁移。
```

### 3.2 调用方式

| 方式 | 说明 |
|------|------|
| **手动调用** | 用户在终端输入 `/skill-name` |
| **自动调用** | Claude 根据 description 匹配对话上下文，自动加载 |

### 3.3 子代理执行 (Subagent)

Claude Code 的 Skills 可以派生子代理（subagent），Fork 上下文，
动态加载额外文件。这是 OpenClaw 不具备的特性。

### 3.4 上下文预算

如果 Skills 过多，可能超出字符预算（默认 15,000 字符）。
可通过 `SLASH_COMMAND_TOOL_CHAR_BUDGET` 环境变量调整上限。
运行 `/context` 可查看是否有 Skills 被排除。

### 3.5 存储位置

```
项目级 Skills:  .claude/skills/*/SKILL.md
用户级 Skills:  ~/.claude/skills/*/SKILL.md
旧命令兼容:     .claude/commands/*.md
```

### 3.6 工作原理

```
用户消息 → Claude 检查 skill descriptions
                │
        ┌───────┴───────┐
        ▼               ▼
  匹配到 Skill      未匹配
        │               │
        ▼               ▼
  注入 SKILL.md     正常响应
  到当前上下文
        │
        ▼
  Claude 按指令执行
```

Skills 不是独立进程、子代理或外部工具——它们是**按需注入的指令**，
在主对话中引导 Claude 的行为，同时保持核心 prompt 精简。

---

## 四、OpenClaw Skill 的特有扩展

### 4.1 更丰富的前置元数据

OpenClaw 在标准基础上扩展了多个 YAML 字段：

```yaml
---
name: my-skill
description: 技能描述
homepage: https://example.com
user-invocable: true              # 是否暴露为用户斜杠命令
disable-model-invocation: false   # 是否从模型 prompt 中排除
command-dispatch: tool            # 绕过模型直接调用工具
command-tool: exec_shell          # 直接调用的工具名
metadata:
  openclaw:
    homepage: https://example.com
    emoji: 🔧
    installer:                    # 安装器元数据（Claude Code 没有）
      brew: my-package
      node: my-npm-package
      download: https://example.com/binary
---
```

### 4.2 安装器元数据 (Installer Metadata)

OpenClaw 支持在前置元数据中声明依赖的安装方式（brew / npm / download），
Gateway 会**自动选择最佳安装选项**。这是 Claude Code 不具备的。

### 4.3 三级加载优先级

```
工作区 Skills (最高优先级)
    │
    ▼
托管 Skills: ~/.openclaw/skills/
    │
    ▼
内置 Skills (最低优先级，随安装包自带)
```

### 4.4 热更新

OpenClaw 默认监听 skill 文件夹，`SKILL.md` 变化时自动更新快照。

### 4.5 Nix 插件系统

可将 Skill + CLI 二进制 + 配置需求打包为 Nix 插件。

### 4.6 公共注册表 (ClawHub)

[ClawHub](https://github.com/openclaw/clawhub) 提供：
- 发布 / 版本管理 / 向量搜索
- 审核钩子
- 700+ 社区技能

### 4.7 Prompt 注入方式

OpenClaw 将合格的 Skills 编译为**紧凑 XML 列表**注入 system prompt：
- 基础开销：195 字符（≥1 个 skill 时）
- 每个 skill：97 字符 + name/description/location 长度

---

## 五、逐项对比

| 维度 | Claude Code Skill | OpenClaw Skill |
|------|------------------|----------------|
| **基础格式** | SKILL.md (YAML + Markdown) | SKILL.md (YAML + Markdown) |
| **底层标准** | Agent Skills Spec（创建者） | Agent Skills Spec（兼容实现） |
| **必需字段** | name, description | name, description |
| **斜杠命令** | ✅ `/skill-name` | ✅ `/skill-name`（通过 `user-invocable`） |
| **自动调用** | ✅ 基于 description 匹配 | ✅ 基于 description 匹配 |
| **手动禁止自动调用** | ❌ | ✅ `disable-model-invocation: true` |
| **子代理执行** | ✅ 可派生 subagent | ❌ |
| **绕过模型直接调用工具** | ❌ | ✅ `command-dispatch: tool` |
| **安装器元数据** | ❌ | ✅ brew / npm / download |
| **Nix 插件打包** | ❌ | ✅ |
| **公共注册表** | Anthropic 官方 marketplace | ClawHub（700+ 社区技能） |
| **热更新** | ❌ 需重启 | ✅ 文件变化自动更新 |
| **上下文预算** | 15,000 字符（可配置） | 195 + 97*N 字符（XML 注入） |
| **模型支持** | 仅 Claude | 任意 LLM |
| **存储位置** | `.claude/skills/` | `~/.openclaw/skills/` + workspace + bundled |
| **注入方式** | 按需扩展 prompt | 编译为 XML 列表注入 system prompt |

---

## 六、互操作性

### 6.1 理论上的互通

由于共享 Agent Skills 标准，核心格式一致：

```
一个标准的 SKILL.md（只用 name + description + markdown 指令）
    │
    ├── 放入 .claude/skills/      → Claude Code 可用 ✅
    ├── 放入 ~/.openclaw/skills/  → OpenClaw 可用   ✅
    ├── 放入 Cursor               → Cursor 可用     ✅
    └── 放入 Codex CLI            → Codex 可用      ✅
```

### 6.2 实际的限制

- 使用了 OpenClaw **特有扩展字段**（如 `command-dispatch`、`installer`）的 Skill，
  在 Claude Code 中会被忽略这些字段，但不会报错
- 使用了 Claude Code **子代理特性**的 Skill，在 OpenClaw 中无法执行子代理部分
- 引用了特定工具名（如 OpenClaw 的 `exec_shell` 或 Claude Code 的 `Bash`）的
  Skill 不可直接互通

### 6.3 跨平台方案：OpenSkills

[OpenSkills](https://github.com/numman-ali/openskills) 项目提供了通用 Skills
加载器，让同一份 Skill 在 Claude Code、Cursor、Windsurf、Aider、Codex 等
工具中都能使用——格式完全兼容。

---

## 七、总结

```
                Agent Skills Open Standard
                (Anthropic 发起的开放规范)
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
       Claude Code    OpenClaw     其他工具
       (原生实现)    (兼容实现)   (Cursor/Codex等)
            │            │
       特有扩展:      特有扩展:
       - 子代理       - 安装器元数据
       - 动态上下文   - 热更新
       - 命令合并     - Nix 插件
                      - ClawHub 注册表
                      - 模型无关
```

**核心关系**: 同根同源。两者的 Skill 系统都基于 Anthropic 发起的
Agent Skills 开放标准，核心文件格式（SKILL.md）完全一致。
差异在于各自的扩展特性——Claude Code 偏向深度编码集成，
OpenClaw 偏向通用自动化和生态多样性。

---

## 参考来源

- [Agent Skills Specification](https://github.com/agentskills/agentskills)
- [Anthropic Skills 仓库](https://github.com/anthropics/skills)
- [Extend Claude with Skills - Claude Code 官方文档](https://code.claude.com/docs/en/skills)
- [Skills - OpenClaw 官方文档](https://docs.openclaw.ai/tools/skills)
- [Claude Code Merges Slash Commands Into Skills - Medium](https://medium.com/@joe.njenga/claude-code-merges-slash-commands-into-skills-dont-miss-your-update-8296f3989697)
- [Inside Claude Code Skills: Structure, Prompts, Invocation](https://mikhail.io/2025/10/claude-code-skills/)
- [Agent Skills: Anthropic's Next Bid to Define AI Standards - The New Stack](https://thenewstack.io/agent-skills-anthropics-next-bid-to-define-ai-standards/)
- [OpenSkills - Universal Skills Loader](https://github.com/numman-ali/openskills)
- [Understanding Claude Code: Skills vs Commands vs Subagents vs Plugins](https://www.youngleaders.tech/p/claude-skills-commands-subagents-plugins)
- [Claude Skills Compared to Slash Commands - egghead.io](https://egghead.io/claude-skills-compared-to-slash-commands~lhdor)
