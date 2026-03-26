# LLM 检索规范 Spec

> 适用对象：开发者、智能体、文档检索工具链。  
> 目标：降低“检索到旧文档导致误答”的概率，提高实现问题回答的一致性与可追溯性。

## 1. 检索优先级

固定优先级：

1. 代码（最终真值）
2. `Tier A` 规范文档
3. `Tier B` 操作文档
4. `Tier C` 历史资料

当回答涉及“当前实现是什么”时，必须至少引用一份代码来源。

## 2. 查询路由表（Topic Router）

| 查询主题 | 首选文档 | 代码真值 | 备注 |
|---|---|---|---|
| 任务状态机 / 状态转换 | `docs/task-operations/README.md` + `docs/task-operations/*` | `packages/api/src/task-coordinator/completer.ts`, `packages/api/src/task-coordinator/routes/index.ts` | 如与文档冲突，以代码为准 |
| delegate / sub-delegate 语义 | `docs/task-operations/DELEGATE.md`, `docs/task-operations/DASHBOARD_CREATE.md` | `packages/api/src/task-coordinator/routes/index.ts`, `packages/clawteam-gateway/src/gateway/gateway-proxy.ts` | 重点看 `/:taskId/delegate` 双模式 |
| dashboard intent 委托链路 | `docs/task-operations/DASHBOARD_CREATE.md`, `docs/Gateway/TaskRouter.md` | `packages/clawteam-gateway/src/routing/router.ts`, `packages/dashboard/src/components/CreateTaskModal.tsx` | 注意 inbox 驱动语义 |
| Gateway `/gateway/*` 端点 | `docs/api-reference/api-endpoints.md`, `docs/Gateway/GATEWAY_TASK_MANAGEMENT.md` | `packages/clawteam-gateway/src/gateway/gateway-proxy.ts` | 端点以代码路由为准 |
| Router API `/status /sessions /tasks ...` | `docs/api-reference/api-endpoints.md`, `docs/Gateway/GATEWAY_TASK_MANAGEMENT.md` | `packages/clawteam-gateway/src/server/router-api.ts` | 包含 manual nudge/cancel/resume |
| session 绑定 / track-session | `docs/guides/SESSION_MANAGEMENT.md` | `packages/openclaw-plugin/index.ts`, `packages/api/src/task-coordinator/routes/index.ts` | 需区分 sender/executor |
| plugin 注入逻辑与 token | `docs/FAQ/plugin-not-injecting-template.md` | `packages/openclaw-plugin/index.ts`, `packages/openclaw-plugin/task_system_prompt_*.md` | 旧 `_clawteam_*` 文档视为历史 |
| nudge / recovery 判定 | `docs/task-operations/NUDGE.md`, `docs/task-operations/RECOVERY.md`, `docs/Gateway/StaleTaskRecoveryLoop.md` | `packages/clawteam-gateway/src/recovery/stale-task-recovery-loop.ts` | 必须核对最新策略 |
| pending_review 审核流程 | `changelogs/`（仓库根目录）+ task operations | `packages/api/src/task-coordinator/routes/index.ts`, `packages/api/src/task-coordinator/completer.ts` | 关注 submit-result/approve/request-changes/reject |
| FAQ 排障 | `docs/FAQ/*` | 对应代码模块 | FAQ 为实战经验，非完整规范 |

## 3. 文档冲突判定规则

若命中多个文档，按下列规则排序：

1. 路径优先：`docs/spec` > `docs/task-operations` > `docs/Gateway` > `docs/architecture` > `docs/references`/`docs/openclaw session_spawn扩展方案`
2. 内容优先：提到新术语（如 `pending_review`, `submit-result`, `delegate-intent inbox`）优先于旧术语（如 `/start`, `_clawteam_*`, `[CLAWTEAM_META]`）
3. 时间优先：带明确近期修订信息的内容优先

## 4. 高风险问题的最小证据要求

以下问题回答时，至少交叉 2 个来源（1 文档 + 1 代码）：

- 权限边界（谁能 approve/reject/cancel/delegate）
- 状态转换（何时进入 `pending_review` / `waiting_for_input`）
- 会话映射（`senderSessionKey` / `executorSessionKey` / `task_sessions`）
- 自动恢复策略（何时 nudge / reset / fallback / terminalize）

## 5. 不建议直接作为实现依据的目录

- `docs/references/`：调研与背景材料
- `docs/openclaw session_spawn扩展方案/`：历史方案讨论，包含多种已演进写法

这些目录可用于“为什么这样设计”的背景，不用于“当前代码怎么做”的直接结论。

## 6. 新文档编写模板（建议）

建议后续规范文档采用统一头部：

```md
---
doc_type: spec
tier: A
status: active
last_verified: 2026-03-22
code_sources:
  - packages/xxx/yyy.ts
keywords:
  - delegation
  - session-tracking
---
```

这样可直接被检索器消费并支持版本化验证。
