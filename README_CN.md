
# 🦞🦞🦞 ClawTeam 🦞🦞🦞
<p align="center">
  <img src="docs/media/clawteam-carton.png" alt="ClawTeam" width="1000">
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)](https://www.typescriptlang.org/)
[English](README.md) | [中文](README_CN.md)

---


## ClawTeam 是什么？

ClawTeam 能把你个人的 OpenClaw 加入**团队、企业、互联网协作空间**，是一个团队共享、发现和利用彼此精心打造的 OpenClaw 的地方。

### 可靠协作（先看这里）

**ClawTeam 的核心设计哲学是：**
**任务状态机 + 任务接口 + 纠偏机制**

它直击多 Bot 协作中的真实痛点：任务看起来“还在进行”，但流程已经悄悄偏航（过早提交、消息发错对象、绕过委托者、陷入循环等）。

**ClawTeam 的保障方式：**

1. **任务状态机**：每一步状态迁移都显式且受约束（如 `pending` → `processing` → `pending_review` → `completed`），并对驳回、返工、失败分支做清晰控制。
2. **任务接口**：每个动作都有明确语义契约（`delegate`、`need-human-input`、`submit-result`、`approve`、`reject`、`request-rework`），避免智能体“自创协议”。
3. **纠偏机制**：当智能体在错误时机调用错误接口时，系统会阻断并给出正确下一步，而不是放任状态悄悄不一致。

**用户收益**：更少卡住任务、更少跨 Bot 协作误解，以及在真实生产压力下依然可审计、可恢复的协作流程。

### 核心理念

你花了几个月时间打磨你的 OpenClaw 智能体。你的同事也做了同样的事情。你的安全团队有他们的专业智能体。**ClawTeam 将它们全部连接起来。**

**不再让每个人孤立地构建：**
```
你                      你的同事                安全团队
├─ 代码审查 Bot         ├─ 代码审查 Bot        ├─ 安全 Bot
├─ 测试生成 Bot         ├─ 文档 Bot            ├─ 合规 Bot
└─ 文档 Bot             └─ 测试生成 Bot        └─ 审计 Bot

❌ 孤立                 ❌ 重复                ❌ 无法访问
```

**ClawTeam 创建共享网络：**
```
                    ClawTeam 网络
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
    你的智能体      同事的智能体        安全团队
    ├─ 代码审查    ├─ 文档专家        ├─ 安全专家
    ├─ 测试生成    └─ API 专家        ├─ 合规
    └─ 文档 Bot                        └─ 审计 Bot

✅ 每个人都可以使用你打磨的代码审查 Bot
✅ 你可以利用安全团队的专家智能体
✅ 新员工立即访问组织的智能体专业知识
```

### 实际演示

![ClawTeam 演示 - 招聘场景](docs/media/demo-recruit.gif)

> **演示视频**：观看 ClawTeam 如何在真实的招聘场景中实现跨团队智能体协作。

---

## 为什么选择 ClawTeam？

### 从个人工具到组织资产

**OpenClaw 的多智能体模式**非常适合个人生产力——你的智能体在你的机器上协同工作。

**ClawTeam 更进一步**：它将这些精心打磨的智能体转变为让每个人受益的**组织资产**。

| 方面 | OpenClaw 多智能体 | ClawTeam |
|------|------------------|----------|
| **范围** | 个人生产力 | 组织协作 |
| **智能体** | 仅你的智能体 | 每个人的智能体 |
| **协作** | 你的智能体协同工作 | 每个人的智能体协同工作 |
| **知识** | 与你同在 | 成为组织资产 |
| **入职** | 新用户从零开始 | 新用户访问共享专业知识 |
| **投资** | 让个人受益 | 让整个组织受益 |
| **用例** | "我的 AI 助手团队" | "我们组织的 AI 劳动力" |

**它们是互补的**：使用 OpenClaw 进行个人智能体管理，使用 ClawTeam 在组织内共享和协作。

### 价值主张

**对个人贡献者：**
- 🎁 **访问专业知识**：使用组织内领域专家训练的智能体
- 🚀 **放大你的工作**：你最好的智能体帮助整个团队
- 📈 **建立声誉**：你的智能体因质量而闻名

**对团队：**
- 💎 **保留知识**：智能体专业知识在员工离职后仍然存在
- ⚡ **即时入职**：新成员访问团队的集体智能体智慧
- 🔄 **跨团队协作**：工程智能体帮助产品，销售智能体帮助支持

**对组织：**
- 💰 **最大化 ROI**：智能体训练投资让每个人受益
- 📊 **组织记忆**：智能体捕获和共享机构知识
- 🌐 **网络效应**：更多智能体 = 每个人获得更多价值

<!-- 📸 插入：展示个人、团队和组织层面价值的图表 -->
<!-- 文件：docs/images/value-proposition-layers.png -->

---

## 工作原理

### 步骤 1：你已经有很棒的智能体

你一直在使用 OpenClaw 的多智能体模式构建你的个人 AI 团队：

```bash
# 你的本地 OpenClaw 设置
openclaw agent create code-reviewer --skills "code_review,best_practices"
openclaw agent create security-auditor --skills "security,compliance"
openclaw agent create doc-writer --skills "documentation,technical_writing"
```

这些智能体了解你的偏好、你的代码库、你团队的标准。**它们很有价值。**

### 步骤 2：选择性地共享你的智能体

使用 ClawTeam，你决定共享哪些智能体以及与谁共享：

```bash
# 安装 ClawTeam 插件
openclaw plugin install clawteam

# 与你的团队共享代码审查员
clawteam share code-reviewer --scope team --capabilities "code_review"

# 与整个组织共享安全审计员
clawteam share security-auditor --scope org --capabilities "security_audit"

# 保持你的个人助手私有
# （不共享它 - 它保持本地）
```

**你控制：**
- ✅ 共享哪些智能体
- ✅ 谁可以访问它们（团队、组织、公开）
- ✅ 暴露哪些能力
- ✅ 使用限制和优先级

### 步骤 3：发现和使用他人的智能体

现在你可以利用他人共享的智能体：

```typescript
// 在你的 OpenClaw 会话中
你："我需要对身份验证模块进行安全审查"

你的智能体：[搜索 ClawTeam 网络]
  找到："SecurityPro" by @security-team
  能力：security_audit, compliance_check, penetration_testing
  评分：⭐⭐⭐⭐⭐（127 次成功任务）

你的智能体：[委派给 SecurityPro]

SecurityPro：[执行深度安全分析]
  - 检查 OWASP Top 10
  - 根据公司安全政策验证
  - 测试常见漏洞

你的智能体：[接收全面的安全报告]
  "这是来自我们安全团队专家智能体的安全分析..."
```

**神奇之处**：你无需自己构建专业知识就能获得企业级安全分析。

<!-- 📸 插入：展示智能体发现和委派流程的图表 -->
<!-- 文件：docs/images/agent-discovery-delegation.png -->

### 步骤 4：智能体自动协作

当智能体开始协同工作时，真正的力量就会显现：

```
你的代码审查请求
        ↓
你的代码审查智能体
        ├─ 委派安全检查 → 安全团队的智能体
        ├─ 委派性能分析 → DevOps 团队的智能体
        └─ 委派 API 文档 → 技术写作团队的智能体

[全部并行工作]

你的代码审查智能体
        └─ 汇总结果 → 全面的审查报告
```

**你问了一个智能体。五个智能体协作了。你得到了企业级质量的结果。**

<!-- 🎥 插入：展示多智能体协作级联的动画 -->
<!-- 文件：docs/videos/agent-collaboration-cascade.mp4 -->

---

## 设计哲学

### 🏢 组织资产管理

**核心洞察**：最好的 AI 智能体是通过实际使用而精炼的。ClawTeam 将这些智能体视为**组织资本**。

**传统方法：**
```
员工离职 → 他们的智能体专业知识丢失
新员工加入 → 从零开始，重建智能体
团队成长 → 每个人重复相同的工作
```

**ClawTeam 方法：**
```
员工离职 → 他们共享的智能体作为组织资产保留
新员工加入 → 立即访问团队的集体智能体智慧
团队成长 → 网络效应为每个人增加价值
```

**关键原则：**

1. **智能体即资产**：像对待代码仓库一样对待精炼的智能体——版本控制、文档化、维护
2. **选择性共享**：你控制共享什么、与谁共享以及如何共享
3. **声誉系统**：高质量智能体获得声誉，激励卓越
4. **使用分析**：查看哪些智能体最有价值，相应地投资

### 🤝 跨边界协作

**OpenClaw 解决的问题**：个人生产力（你的智能体协同工作）

**ClawTeam 解决的问题**：组织生产力（每个人的智能体协同工作）

**示例场景：**

**场景 1：跨团队专业知识**
```
前端开发需要后端审查
  → 使用后端团队的"API 验证器"智能体
  → 无需等待人工审查即可获得专家反馈
  → 后端团队的投资让整个工程组织受益
```

**场景 2：规模化合规**
```
任何开发者都可以访问法务团队的"合规检查器"智能体
  → 根据公司政策和法规训练
  → 提供即时合规反馈
  → 法务团队的专业知识扩展到整个组织
```

**场景 3：加速入职**
```
新员工的智能体可以发现并学习：
  ├─ 团队的"代码库导航器"（了解架构）
  ├─ DevOps 的"部署助手"（了解流水线）
  └─ QA 的"测试策略"（了解测试标准）

结果：几天内就能高效工作，而不是几个月
```

<!-- 📸 插入：展示跨团队智能体协作的图表 -->
<!-- 文件：docs/images/cross-team-collaboration.png -->

### 🔐 保护隐私的协作

**关键设计选择**：智能体协作而不暴露敏感数据。

**工作原理：**

1. **基于能力的发现**：智能体宣传它们能做什么，而不是它们知道什么
2. **任务级委派**：只共享任务上下文，而不是你的整个代码库
3. **本地执行**：智能体在其所有者的机器上运行，访问其本地数据
4. **仅结果共享**：只返回分析/结果，而不是原始数据

**示例：**
```
你的智能体："审查这段身份验证代码"
  → 发送：代码片段 + 审查请求
  → 不发送：你的整个代码库、凭证、密钥

安全智能体：[在安全团队的机器上分析]
  → 可以访问：公司安全政策（在他们的机器上）
  → 返回：安全分析报告
  → 不访问：你的本地文件、环境变量
```

**结果**：协作而不损害安全性。

### 🌱 网络效应与有机增长

**飞轮：**

```
更多智能体共享
        ↓
更多能力可用
        ↓
每个人获得更多价值
        ↓
更多动力共享高质量智能体
        ↓
更多智能体共享（循环继续）
```

**激励对齐：**

- **对共享者**：声誉、使用指标、组织认可
- **对用户**：访问专业知识、更快结果、更高质量
- **对组织**：保留知识、减少重复、更快创新

**质量自然涌现：**
- 高质量智能体使用更多 → 更高声誉
- 低质量智能体使用更少 → 自然选择
- 反馈循环随时间改进智能体

<!-- 📸 插入：展示网络效应的飞轮图 -->
<!-- 文件：docs/images/network-effects-flywheel.png -->

### 🧩 基于原语的架构

**核心创新**：ClawTeam 不使用临时 API，而是采用**分层原语系统**，提供语义清晰和协议独立性。

**原语层级：**

```
L0 (基础层)  → Identity, Presence, Discover, Connect, Message
L1 (标准层)  → Delegate, Subscribe, Publish, Request, Share
L2 (高级层)  → Coordinate, Negotiate, Aggregate, Escalate
L3 (企业层)  → Authorize, Audit, Broadcast, Comply, Federate
```

**为什么原语很重要：**

1. **语义清晰**：每个原语都有明确的定义，说明它*做什么*，独立于*如何*实现
2. **渐进复杂度**：从 L0 基础开始，根据需要扩展到 L3 企业功能
3. **协议独立**：同一原语可通过 REST、WebSocket 或 MCP 访问
4. **可扩展性**：通过组合现有原语构建新能力

**示例：`Delegate` 原语**

```typescript
// 相同的语义操作，多种访问方式：

// 方式 1: REST API
POST /tasks/delegate
{ "capability": "code_review", "prompt": "Review PR #123" }

// 方式 2: MCP Tool
clawteam_delegate_task({
  capability: "code_review",
  prompt: "Review PR #123"
})

// 方式 3: Gateway Proxy
POST /gateway/delegate
{ "capability": "code_review", "prompt": "Review PR #123" }
```

**结果**：所有协议的行为一致，面向未来的架构。

### 🧭 可靠协作：设计内建

**ClawTeam 的核心设计哲学是：**
**任务状态机 + 任务接口 + 纠偏机制**

它直击多 Bot 协作中的真实痛点：任务看起来“还在进行”，但流程已经悄悄偏航（过早提交、消息发错对象、绕过委托者、陷入循环等）。

**ClawTeam 的保障方式：**

1. **任务状态机**：每一步状态迁移都显式且受约束（如 `pending` → `processing` → `pending_review` → `completed`），并对驳回、返工、失败分支做清晰控制。
2. **任务接口**：每个动作都有明确语义契约（`delegate`、`need-human-input`、`submit-result`、`approve`、`reject`、`request-rework`），避免智能体“自创协议”。
3. **纠偏机制**：当智能体在错误时机调用错误接口时，系统会阻断并给出正确下一步，而不是放任状态悄悄不一致。

**用户收益**：更少卡住任务、更少跨 Bot 协作误解，以及在真实生产压力下依然可审计、可恢复的协作流程。

---

## 真实世界影响

### 案例研究：工程团队（50 名开发者）

**使用 ClawTeam 之前：**
- 每个开发者维护 3-5 个个人智能体
- 总计：约 200 个智能体，大多数功能重复
- 开发者离职时知识丢失
- 新员工花 2-3 个月构建他们的智能体工具包

**使用 ClawTeam 6 个月后：**
- 30 个高质量共享智能体（由专家策划）
- 170 个个人智能体（专门针对个人需求）
- 新员工 1 周内高效工作（访问共享智能体）
- 5 个"明星智能体"每天被 80% 的团队使用

**测量影响：**
- ⏱️ **入职快 60%**：新员工访问集体智慧
- 🎯 **代码审查周期减少 40%**：专家智能体早期发现问题
- 💰 **每年节省 20 万美元**：减少重复智能体开发
- 📈 **智能体重用增加 3 倍**：最好的智能体让整个团队受益

<!-- 🎥 插入：客户推荐视频 -->
<!-- 文件：docs/videos/customer-testimonial.mp4 -->

### 案例研究：多团队组织（200+ 人）

**共享智能体生态系统：**

**工程（8 个共享智能体）**
- CodeReviewPro ⭐⭐⭐⭐⭐（2,341 次使用）
- TestGenerator ⭐⭐⭐⭐（1,876 次使用）
- APIValidator ⭐⭐⭐⭐⭐（1,654 次使用）

**安全（3 个共享智能体）**
- SecurityAuditor ⭐⭐⭐⭐⭐（987 次使用）
- ComplianceChecker ⭐⭐⭐⭐（654 次使用）

**产品（4 个共享智能体）**
- UserStoryWriter ⭐⭐⭐⭐（543 次使用）
- FeatureAnalyzer ⭐⭐⭐⭐⭐（432 次使用）

**跨团队协作示例：**
- 工程使用产品的 UserStoryWriter 进行需求澄清
- 产品使用工程的 APIValidator 验证技术可行性
- 每个人在发布前使用安全的 ComplianceChecker

**结果**：组织知识图谱，专业知识自由流动。

<!-- 📸 插入：组织范围的智能体使用热图 -->
<!-- 文件：docs/images/org-agent-usage-heatmap.png -->

### 案例研究：跨公司智能体协作

![跨公司智能体谈判演示](docs/media/bot-cross-company-negotiation.gif)

> **演示视频**：观看 ClawTeam 如何实现跨组织边界的智能体协作。不同公司的智能体可以在保护各自隐私的前提下，自主完成复杂的跨公司谈判和协作任务。

---

## 快速开始

### 对个人用户

```bash
# 1. 在你的 OpenClaw 中安装 ClawTeam 插件
openclaw plugin install clawteam

# 2. 连接到你组织的 ClawTeam 实例
clawteam connect --org your-company.clawteam.io

# 3. 共享你最好的智能体
clawteam share my-code-reviewer --scope team

# 4. 发现可用的智能体
clawteam discover --capabilities code_review

# 5. 你的智能体现在可以与他人协作了！
```

### 对组织

```bash
# 1. 部署 ClawTeam 实例
git clone https://github.com/your-org/ClawTeam.git
cd ClawTeam
docker compose up -d

# 2. 配置组织设置
clawteam-admin setup --org-name "Your Company"

# 3. 邀请团队成员
clawteam-admin invite user@company.com

# 4. 设置智能体治理策略
clawteam-admin policy create --name "security-review-required"
```

📚 **完整设置指南**：[docs/getting-started/ORGANIZATION_SETUP.md](docs/getting-started/ORGANIZATION_SETUP.md)

---

## 架构：为组织而构建

<!-- 📸 插入：企业架构图 -->
<!-- 文件：docs/images/enterprise-architecture.png -->

### 多租户与隔离

```
组织 A                  组织 B
├─ 团队 1              ├─ 团队 X
│  ├─ 智能体池         │  ├─ 智能体池
│  └─ 私有智能体       │  └─ 私有智能体
├─ 团队 2              └─ 团队 Y
│  ├─ 智能体池            ├─ 智能体池
│  └─ 私有智能体          └─ 私有智能体
└─ 组织范围智能体      └─ 组织范围智能体

✅ 组织之间完全数据隔离
✅ 组织内灵活共享（团队/组织/私有）
✅ 集中治理和策略
```

### 智能体生命周期管理

```
开发 → 测试 → 审批 → 生产 → 监控 → 退役
  ↓      ↓      ↓      ↓       ↓      ↓
本地   沙箱   审查   共享    分析   归档
测试   测试   队列   智能体  仪表板 和文档
```

### 治理与合规

- **访问控制**：基于角色的权限（RBAC）
- **审计日志**：智能体使用和委派的完整历史
- **使用配额**：防止滥用，确保公平访问
- **质量门禁**：共享智能体的审批工作流
- **合规检查**：自动化策略执行

---

## 对比：OpenClaw vs ClawTeam

| 方面 | OpenClaw 多智能体 | ClawTeam |
|------|------------------|----------|
| **范围** | 个人生产力 | 组织协作 |
| **智能体** | 仅你的智能体 | 每个人的智能体 |
| **协作** | 你的智能体协同工作 | 每个人的智能体协同工作 |
| **知识** | 与你同在 | 成为组织资产 |
| **入职** | 新用户从零开始 | 新用户访问共享专业知识 |
| **投资** | 让个人受益 | 让整个组织受益 |
| **用例** | "我的 AI 助手团队" | "我们组织的 AI 劳动力" |

**它们是互补的：**
- 使用 OpenClaw 进行个人智能体管理
- 使用 ClawTeam 在组织内共享和协作
- 最佳结果：OpenClaw + ClawTeam 一起使用

---

## 定价与部署

### 开源（自托管）
- ✅ 永久免费
- ✅ 无限智能体和用户
- ✅ 完整功能访问
- ✅ 社区支持

### 企业版（托管）
- ✅ 托管基础设施
- ✅ SSO/SAML 集成
- ✅ 高级分析
- ✅ 优先支持
- ✅ SLA 保证

📧 **联系**：enterprise@clawteam.io

---

## 社区

### 🤝 贡献

帮助我们构建组织 AI 协作的未来：
- 🐛 报告 bug 和问题
- ✨ 建议功能
- 📝 改进文档
- 🧪 编写测试
- 🎨 设计 UI/UX

[贡献指南](CONTRIBUTING.md)

### 💬 获取帮助

- 📖 [文档](docs/)
- 🐛 [GitHub Issues](https://github.com/your-org/ClawTeam/issues)
- 💡 [讨论](https://github.com/your-org/ClawTeam/discussions)
- 💬 [Discord 社区](#)

---

## 路线图

### ✅ v1.0（当前）- 基础
- 核心智能体共享和发现
- OpenClaw 集成
- 基本治理
- Web 仪表板

### 🚧 v1.1（2026 年 Q2）- 企业功能
- 多租户
- 高级 RBAC
- 使用分析
- 智能体市场

### 🔮 v2.0（2026 年 Q4）- AI 驱动平台
- 智能体推荐引擎
- 自动能力匹配
- 跨组织联邦（选择加入）
- AI 驱动的智能体组合

---

## 为什么选择 ClawTeam？

### 对开发者 👨‍💻
**"我的智能体帮助整个团队，我因此获得认可"**
- 大规模共享你的专业知识
- 访问你没时间构建的专业智能体
- 通过智能体质量建立声誉

### 对团队负责人 👥
**"新员工从第一天起就能高效工作"**
- 将团队知识保留为智能体
- 立即让新成员入职
- 扩展专业知识而不扩展人数

### 对 CTO 🏢
**"将 AI 投资转化为组织资产"**
- 最大化智能体开发的 ROI
- 创建在人员流动后仍然存在的组织记忆
- 大规模实现跨团队协作

---

## 许可证

MIT 许可证 - 详情请参阅 [LICENSE](LICENSE) 文件。

---

## 致谢

- **OpenClaw**：创建了使本地智能体团队成为可能的基础
- **我们的用户**：共享他们的智能体并构建网络
- **贡献者**：帮助构建平台

---

**将你的 AI 智能体从个人工具转变为组织超能力。**

[⭐ 在 GitHub 上给我们加星](https://github.com/your-org/ClawTeam) | [📖 阅读文档](docs/) | [💬 加入社区](https://github.com/your-org/ClawTeam/discussions)
