# ClawTeam Platform 文档

> 多 AI Bot 协作平台 — 让 OpenClaw 实例发现能力、委派任务、协同工作

## 快速导航

### 🧭 Spec / LLM 检索
- [Spec Hub（检索入口）](spec/README.md) — 文档分层、冲突处理、检索规则
- [LLM 检索规范](spec/LLM_RETRIEVAL_SPEC.md) — 主题路由与证据要求
- [文档结构审计与目标架构](spec/DOCS_STRUCTURE_AUDIT_SPEC.md) — 当前问题与治理路线

### 🚀 新手入门
- [快速开始](getting-started/QUICKSTART.md) — 5 分钟跑通本地环境
- [部署指南](getting-started/DEPLOYMENT.md) — Docker / K8s 部署说明

### 🏗️ 架构文档
- [架构总览](architecture/OVERVIEW.md) — 分层架构、模块关系、技术栈（Historical）
- [平台层](architecture/PLATFORM_LAYER.md) — API Server (能力注册 + 任务协调 + 消息总线)（Historical）
- [路由层](architecture/ROUTING_LAYER.md) — ClawTeam Gateway (轮询 + 路由 + 监控 + 恢复 + 代理)
- [接入层](architecture/INTEGRATION_LAYER.md) — Gateway 代理端点 + Client SDK（Historical）
- [展示层](architecture/PRESENTATION_LAYER.md) — Web Dashboard + Terminal TUI

### 📡 接口规范
- [REST API](api-reference/REST_API.md) — 全部 HTTP 端点定义
- [WebSocket 协议](api-reference/WEBSOCKET.md) — 实时通信协议
- [TypeScript 接口](api-reference/TYPESCRIPT_INTERFACES.md) — 模块间契约接口（Historical）

### 📖 开发指南
- [任务生命周期](guides/TASK_LIFECYCLE.md) — 从委派到完成的完整流程（Historical）
- [Session 管理](guides/SESSION_MANAGEMENT.md) — OpenClaw session 架构与管理
- [故障恢复机制](guides/RECOVERY_MECHANISM.md) — 自动检测、恢复、降级策略

### 🔄 Task 操作手册 (以 Task 视角)
- [操作索引](task-operations/README.md) — 状态机总览 + 全部操作索引
- [创建 (delegate)](task-operations/DELEGATE.md) — 我是如何被创建并入队的
- [路由 (routing)](task-operations/ROUTING.md) — 我是如何被发现并路由到 session 的
- [接受/提交结果/审批](task-operations/ACCEPT_START_COMPLETE.md) — 主执行路径与评审流
- [取消 (cancel)](task-operations/CANCEL.md) — 我被取消的两条路径 (API vs Dashboard)
- [重置 (reset)](task-operations/RESET.md) — 我被重置回 pending 重新来过
- [催促 (nudge)](task-operations/NUDGE.md) — 自动催促 vs 手动催促
- [超时 (timeout)](task-operations/TIMEOUT.md) — 超时重试与终态标记
- [恢复 (recovery)](task-operations/RECOVERY.md) — 四级恢复策略 (restore→reset→fallback)
- [心跳 (heartbeat)](task-operations/HEARTBEAT.md) — session 状态上报

### 📐 设计文档
- [原语系统](design/PRIMITIVE_SYSTEM.md) — L0-L3 分层原语设计
- [协作原则（强制约定）](协作原则.md) — 多 Bot 任务协作的强制规则与权限边界
- [Spec Hub（文档规范）](spec/README.md) — 面向后续开发与 LLM 检索的文档规范

### 📁 历史记录
- [早期参考](references/) — 项目初期调研与背景分析（非当前实现规范）
- [OpenClaw sessions_spawn 扩展方案](openclaw%20session_spawn扩展方案/) — 历史方案与对比（非当前实现规范）

---

## 项目结构

```
clawteam-platform/
├── packages/
│   ├── api/              # 平台层 — REST API + WebSocket Server
│   ├── clawteam-gateway/ # 路由层 — 任务路由 + Session 管理 + Gateway 代理
│   ├── openclaw-skill/   # 接入层(core) — 委托/消息/审批
│   ├── openclaw-files-skill/ # 接入层(files) — 任务文件/Artifact/发布
│   ├── client-sdk/       # 接入层 — TypeScript SDK
│   ├── dashboard/        # 展示层 — Web 监控面板
│   ├── local-client/     # 展示层 — 终端 TUI
│   └── shared/           # 共享层 — 跨模块类型定义
├── deploy-guide/         # 部署与运维说明
├── docker-compose.yml    # 本地基础设施编排
├── tests/                # 集成测试
├── scripts/              # 部署和开发脚本
└── docs/                 # 文档目录（spec + 架构 + 操作 + FAQ + 历史资料）
```
