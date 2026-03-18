# 2026-03-18 — 任务完成审核流程（pending_review）

## 概述

引入 `pending_review` 状态，实现委托者审核机制。执行者完成工作后不再直接标记为 completed，而是提交结果进入 pending_review，由委托者（或 dashboard 用户）审核后 approve 或 reject。

## 状态机变更

```
                                    ┌─── reject ──┐
                                    v              │
pending → processing → pending_review → completed (approve)
             │                │
             v                v
       waiting_for_input   cancelled
```

## 新增 API 端点

| 端点 | 方法 | 说明 | 权限 |
|------|------|------|------|
| `/:taskId/submit-result` | POST | 执行者提交结果，进入 pending_review | toBotId (executor) |
| `/:taskId/approve` | POST | 委托者批准，进入 completed | fromBotId (delegator) |
| `/:taskId/reject` | POST | 委托者拒绝，回到 processing | fromBotId (delegator) |
| `/all/:taskId/approve` | POST | Dashboard 批准（公开端点） | 无需认证 |
| `/all/:taskId/reject` | POST | Dashboard 拒绝（公开端点） | 无需认证 |

## 权限变更

- `complete()` 现在仅允许 fromBotId（委托者）调用，作为跳过审核的快捷方式
- `cancel()` 新增 `pending_review` 为可取消状态

## 向后兼容

Gateway 的 `/gateway/tasks/:taskId/complete` 端点增加了向后兼容逻辑：如果执行者调用 `/complete` 被 API 拒绝（403），自动重定向到 `submit-result`，并记录 deprecation 警告日志。已部署的旧 session 不会中断。

## 数据库迁移

`021_add-pending-review-status.sql`

- `tasks.status` 约束新增 `pending_review`
- 新增列：`submitted_result` (JSONB)、`submitted_at` (TIMESTAMP)、`rejection_reason` (TEXT)

## 涉及文件

### 数据库
- `packages/api/migrations/021_add-pending-review-status.sql` — 新建

### Shared Types
- `packages/shared/types/index.ts` — TaskStatus 增加 `pending_review`，Task 增加 3 个字段，MessageType 增加 `task_pending_review` / `task_rejected`

### API Server
- `packages/api/src/task-coordinator/completer.ts` — 新增 `submitResult()`、`approve()`、`reject()`，修改 `complete()` 和 `cancel()`
- `packages/api/src/task-coordinator/interface.ts` — ITaskCoordinator 增加 3 个方法签名
- `packages/api/src/task-coordinator/coordinator-impl.ts` — 增加 3 个委托方法
- `packages/api/src/task-coordinator/types.ts` — TaskRow 增加 3 个字段，taskRowToTask 增加映射
- `packages/api/src/task-coordinator/constants.ts` — TASK_STATUSES 增加 `pending_review`
- `packages/api/src/task-coordinator/mocks.ts` — MockTaskCoordinator 增加 3 个方法
- `packages/api/src/task-coordinator/routes/index.ts` — 新增 5 个端点，更新 cancel SQL 和 GET /all 查询
- `packages/api/src/message-bus/interface.ts` — REDIS_CHANNELS 和 getChannelForEvent 增加新事件

### Gateway
- `packages/clawteam-gateway/src/gateway/gateway-proxy.ts` — 新增 3 个代理端点 + /complete 向后兼容
- `packages/clawteam-gateway/src/gateway/response-formatter.ts` — 新增 3 个格式化函数
- `packages/clawteam-gateway/src/routing/router.ts` — 指令消息中 `/complete` → `/submit-result`

### Plugin / Skill
- `packages/openclaw-plugin/task_system_prompt.md` — `/complete` → `/submit-result`
- `packages/openclaw-skill/SKILL.md` — 更新操作文档和自治行为规则表

### Dashboard
- `packages/dashboard/src/lib/types.ts` — TaskStatus 增加 `pending_review`，Task 增加 3 个字段
- `packages/dashboard/src/lib/router-api.ts` — 新增 `approveTask()`、`rejectTask()`
- `packages/dashboard/src/components/StatusBadge.tsx` — 增加 `pending_review` 样式（indigo）
- `packages/dashboard/src/components/TaskKanban.tsx` — 新增 "Pending Review" 列
- `packages/dashboard/src/components/TaskActions.tsx` — 新增 Approve / Reject 按钮
- `packages/dashboard/src/pages/TaskDetail.tsx` — 新增 pending_review 审核面板
