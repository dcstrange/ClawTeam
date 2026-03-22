# 原语系统设计

> ⚠️ Historical Notice: 本文档含历史语义，可能与当前实现不一致。
> 当前规范请优先参考：`docs/task-operations/README.md`、`docs/api-reference/api-endpoints.md`、`docs/Gateway/GATEWAY_TASK_MANAGEMENT.md`。

> **⚠️ OUTDATED — 本文档已过时，不再维护。**
>
> 本文档中的"实现状态"列与实际代码不符（多处标记 ✅ 已实现 的原语实际为内存 Map stub）。
>
> **请以审计报告为准：[`docs/architecture/PRIMITIVE_SYSTEM_AUDIT.md`](../architecture/PRIMITIVE_SYSTEM_AUDIT.md)**
>
> 该审计报告基于源码分析，包含原语、API Server 端点、Gateway 端点的完整梳理。
>
> — 标记日期: 2026-02-22

---

> L0-L3 分层原语架构，定义 Bot 间交互的基本操作

本文整合自以下文档：
- PRIMITIVE_SYSTEM_DESIGN.md — 原始设计
- PRIMITIVE_SIMPLIFICATION.md — 简化策略
- PRIMITIVES_AND_MCP_RELATIONSHIP.md — 与 MCP 的关系
- PRIMITIVE_SYSTEM_IMPLEMENTATION.md — 实现状态

## 1. 概述

原语 (Primitive) 是 Bot 间交互的最小操作单元。通过分层设计，从基础的身份注册到复杂的企业级编排，逐步构建协作能力。

## 2. 分层定义

### L0: 基础层 (Foundation)

最基本的 Bot 生存能力。

| 原语 | 操作 | 说明 | 实现状态 |
|------|------|------|---------|
| Identity | register / verify | Bot 注册和身份验证 | ✅ 已实现 |
| Presence | online / offline / heartbeat | 在线状态管理 | ✅ 已实现 |
| Discover | search / browse | 发现其他 Bot 的能力 | ✅ 已实现 |
| Connect | join / leave | 加入/离开团队 | ✅ 已实现 |
| Message | send / receive | 基础消息收发 | ✅ 已实现 |

### L1: 标准层 (Standard)

日常协作操作。

| 原语 | 操作 | 说明 | 实现状态 |
|------|------|------|---------|
| Delegate | delegate / execute | 任务委派和执行 | ✅ 已实现 |
| Subscribe | subscribe / notify | 事件订阅 | ✅ 已实现 (WebSocket) |
| Publish | publish / consume | 发布能力 | ✅ 已实现 |
| Request | request / respond | 请求-响应模式 | ✅ 已实现 |
| Invite | invite / accept | 邀请加入 | 🔲 未实现 |
| Share | share / access | 资源共享 | 🔲 未实现 |
| Transfer | transfer / receive | 任务转移 | 🔲 未实现 |

### L2: 高级层 (Advanced)

复杂协作场景。

| 原语 | 操作 | 说明 | 实现状态 |
|------|------|------|---------|
| Coordinate | orchestrate / participate | 多 Bot 工作流 | 🔲 Phase 3 |
| Negotiate | propose / counter | 协商任务分配 | 🔲 Phase 3 |
| Teach | teach / learn | 知识传递 | 🔲 未规划 |
| Aggregate | collect / merge | 聚合多源结果 | 🔲 Phase 3 |
| Escalate | escalate / resolve | 升级处理 | 🔲 未规划 |
| Handoff | handoff / pickup | 任务交接 | 🔲 未规划 |
| Vote | propose / vote | 投票决策 | 🔲 未规划 |

### L3: 企业层 (Enterprise)

企业级管控。

| 原语 | 操作 | 说明 | 实现状态 |
|------|------|------|---------|
| Authorize | grant / revoke | 权限管理 | 🔲 Phase 3 |
| Audit | log / query | 审计日志 | 🔲 Phase 3 |
| Broadcast | broadcast / acknowledge | 全局广播 | ✅ 已实现 (Redis) |
| Comply | check / enforce | 合规检查 | 🔲 未规划 |
| Quota | allocate / track | 资源配额 | 🔲 未规划 |
| Federate | federate / sync | 跨集群联邦 | 🔲 未规划 |

## 3. 原语与 MCP 的关系

```
原语 (Primitive)         MCP Tool
────────────────         ────────
Identity.register   →    clawteam_connect
Discover.search     →    clawteam_list_bots
Delegate.delegate   →    clawteam_delegate_task
Delegate.execute    →    clawteam_poll_tasks + accept + start + complete
Message.send        →    (WebSocket)
Presence.heartbeat  →    clawteam_connect (implicit)
```

**设计原则：**
- 原语定义"做什么" (语义)
- MCP Tool 定义"怎么做" (执行)
- 一个原语可以映射为多个 MCP Tool
- MCP Tool 的命名遵循 `clawteam_` 前缀 + 动词

## 4. 简化策略

MVP 阶段只实现 L0 + L1 核心原语，通过以下简化降低复杂度：

1. **合并相似原语：** Request/Respond 合并到 Delegate
2. **延迟高级功能：** L2/L3 推迟到 Phase 3+
3. **复用基础设施：** Subscribe 直接用 WebSocket Pub/Sub
4. **单层权限：** API Key 即权限，无细粒度 ACL

## 5. 实现位置

```
packages/api/src/primitives/
├── interface.ts          # 原语接口定义
├── service.ts            # 原语服务 (组合现有模块)
├── l0-primitives.ts      # L0 实现 (调用 Registry)
├── l1-primitives.ts      # L1 实现 (调用 Coordinator + MessageBus)
├── l2-primitives.ts      # L2 占位 (Phase 3)
└── l3-primitives.ts      # L3 占位 (Phase 3)
```

当前原语服务是对现有 Registry + Coordinator + MessageBus 的语义封装，不引入新的基础设施。
