# 2026-03-22 — debug_0318 分支汇总（委托链路、提示词注入、恢复策略）

## 概述

本分支自创建以来，围绕「任务委托与子委托」主链路完成了一轮集中修复。重点解决了 dashboard 展示链路不正确、sender/executor 子会话提示词信息不完整、plugin 注入重复、以及 Nudge 误触发导致任务被错误 cancel/fail 的问题。

本次汇总同时覆盖了我们讨论中确认的设计原则：

- 任何任务参与方都可发起 sub-delegate（不只 executor）
- sub-delegate 必须形成父子任务关系（`parentTaskId`）
- sub-task 必须拥有独立 taskId，并与其会话进行 session 绑定
- `fromBotId` 必须与本地 bot 身份一致（防伪造/误路由）

## 关键行为变更

### 1) Delegate / Sub-delegate 语义统一

- API `POST /api/v1/tasks/:taskId/delegate` 拆分为两种模式：
- 直接委托（无 `subTaskPrompt`）：保留原语义，仅原始委托者可在 `pending` 阶段指派执行者。
- 子委托（有 `subTaskPrompt`）：允许任务参与方发起，自动创建子任务并设置 `parentTaskId`，再委托到目标 bot。
- Gateway `POST /gateway/tasks/:taskId/delegate` 透传后返回真实被委托 taskId（可能是新建 sub-task），并在响应中区分 `delegationMode=direct|sub-task`。
- Gateway 跟踪逻辑改为绑定「真实 delegatedTaskId」，避免把父任务 session 错绑到子任务。

### 2) 委托链路与身份校验增强

- Gateway 新增 `fromBotId` 与本地 `clawteamBotId` 一致性校验，不一致时拒绝请求。
- Gateway 保留并强化自委托拦截（`toBotId === localBotId`）。
- Plugin 在 sender 角色 `sessions_spawn` 前增加 identity guard：marker 中 `fromBotId` 必须与本地 bot 一致。

### 3) Dashboard Intent 元数据补全

- Dashboard 创建 delegate intent task 时，额外写入 `delegateIntent` 元数据：
- `toBotId`
- `toBotName`
- `toBotOwner`
- Router 在构造 delegate intent 下发消息时，会把目标执行者 ID/名称/Owner 同步到 task value 与 `<!--CLAWTEAM:...-->` token，避免 sender 子会话缺少目标执行者信息。

### 4) Plugin 提示词注入链路修复

- Plugin 改为 role-specific 模板（sender / executor）并支持 `TO_BOT_*` 变量。
- Marker 解析支持结构化 token + 纯文本 fallback，兼容旧格式。
- 新增幂等保护：当 `task` 已是完整渲染的 ClawTeam sub-session 上下文时，跳过二次模板 prepend，防止出现双份
`[ClawTeam Sub-Session Context]` 与双份 `=== TASK CONTENT BEGINS BELOW ===`。
- 修复副作用：二次注入导致第一段 `DELEGATOR` 空值的问题不再出现。

### 5) Nudge / Recovery 误判修复

- Stale recovery 仅在真正 stale 时累计尝试数；活跃或未到阈值状态会重置计数。
- `idle/completed/errored` 统一引入 staleness 阈值与冷却窗口，减少误触发。
- `waiting_for_input` 与 `pending_review` 直接跳过 recovery（并重置计数）。
- 对 sender 监控会话增加保护：任务活跃但 sender session 已完成委托时，不应被 nudge。
- 非 dead 会话达到尝试上限后不再直接 terminalize 任务；仅 dead 会话允许进入 cancel/fail 分支。

## Dashboard 展示与交互侧更新

- Task 详情与看板状态对 `pending_review` 流程支持增强。
- 审核动作（approve/reject）在 dashboard 与 gateway 侧联通。
- 任务详情中 session/状态信息展示与 routing 数据同步能力增强。

## 文档与排障资料

- 新增 FAQ：
- executor self-delegation 规则
- gateway 重复 cancel 问题排查
- plugin 模板注入失败排查
- track-session 与 tasks 表不同步排查
- Gateway / Router 文档更新，补齐新的委托/子委托与会话追踪语义。

## 回归脚本

- 新增端到端回归脚本：
- `tests/sessions-spawn-test/executor_subsession_prompt_regression.ts`
- 覆盖点：
- 已渲染 executor 子会话提示词再次经过 plugin hook 时不得重复注入
- `DELEGATOR` 信息必须保持可用（不应被清空）

## 涉及核心模块

- API：`packages/api/src/task-coordinator/*`，迁移 `021_add-pending-review-status.sql`
- Gateway：`packages/clawteam-gateway/src/gateway/*`、`routing/router.ts`、`recovery/stale-task-recovery-loop.ts`
- Dashboard：`packages/dashboard/src/components/*`、`packages/dashboard/src/lib/*`
- Plugin：`packages/openclaw-plugin/index.ts`、`task_system_prompt_executor.md`、`task_system_prompt_sender.md`
- Skill：`packages/openclaw-skill/SKILL.md`
