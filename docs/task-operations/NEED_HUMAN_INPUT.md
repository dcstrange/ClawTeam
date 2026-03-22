# 请求人类输入 (need-human-input) & 恢复 (resume)

## 概述

当 bot 在执行任务过程中遇到缺少信息、需要人类决策等情况时，可以调用 `/need-human-input` 将任务标记为 `waiting_for_input`。人类用户通过 Dashboard Inbox 查看请求并回复后，任务恢复为 `processing`。

## 核心原则

**每个 bot 只能向自己的人类用户发送请求。** Bot 之间的信息交换走 DM，人类只在自己的 bot 搞不定时才被拉进来。

## 状态变化

```
accepted / processing  ──need-human-input──▶  waiting_for_input
                                                     │
                                               resume (人类回复)
                                                     │
                                                     ▼
                                                processing
```

**可重入**: 任务已在 `waiting_for_input` 时，另一方 bot 仍可调 `/need-human-input`，此时 `waitingReason` 和 `waitingRequestedBy` 被更新为新调用方。

**其他合法操作**: `waiting_for_input` 状态下也可调用 `complete`（完成/失败）和 `reset`（重置为 pending）。

## 信息获取优先级（executor 视角）

1. **需要委托方才知道的信息**（如旅客姓名、证件号）→ 先 DM 委托方 bot
   - 委托方 bot 可能自己就能回答（从 intent 上下文中）
   - 委托方 bot 也不知道 → 委托方 bot 调 `/need-human-input` 问自己的人类
   - 委托方人类回复 → 系统自动投递给 executor
2. **需要自己人类用户才知道的信息**（如领域知识、操作权限）→ 调 `/need-human-input`

## 涉及模块

### API 层

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/tasks/:taskId/need-human-input` | POST | 标记任务为 waiting_for_input |
| `/api/v1/tasks/:taskId/resume` | POST | 恢复任务为 processing，可附带 humanInput |

**权限**：fromBotId 和 toBotId 均可调用（通过 X-Bot-Id header 鉴权）。

### Gateway 代理层

| 端点 | 说明 |
|------|------|
| `/gateway/tasks/:taskId/need-human-input` | 代理到 API，自动注入 auth |
| `/gateway/tasks/:taskId/resume` | 代理到 API，自动注入 auth |

### completer.ts

- `waitForInput(taskId, botId, reason)` — 验证权限和状态，更新 task.result.waitingReason
- `resumeFromWaiting(taskId, botId, humanInput?)` — 恢复状态，若有 humanInput 则写入 task.result 并通过 `writeHumanInputToInbox()` 投递到 toBotId 的 Redis inbox

### Dashboard

- **Inbox 页面** — 显示 `waiting_for_input` 状态的任务（executor 和 delegator 均可见）
- **Navbar 徽章** — 显示待处理的 inbox 数量
- **TaskActions** — resume 确认弹窗中可输入 humanInput

## 跨 Gateway 投递

`resumeFromWaiting` 中的 `writeHumanInputToInbox()` 将 humanInput 作为 `direct_message` 写入 toBotId 的 Redis inbox（`clawteam:inbox:{toBotId}:{priority}`）。toBotId 的 gateway 通过 polling 拾取并投递到 executor session。

这确保了即使 Dashboard 运行在 delegator 的本地 gateway 上，humanInput 也能正确到达 executor。

## Recovery 豁免

`waiting_for_input` 状态的任务在 recovery loop 中被跳过（不 nudge、不 fail），因为任务在合法等待人类输入。

## 冲突纠正机制（pending_review ↔ need-human-input）

常见误用：executor 过早 `submit-result` 进入 `pending_review`，随后 delegator 发现还缺信息并调用 `need-human-input`，会产生状态冲突。

Gateway 代理层已加入自动纠正：
- 若 `need-human-input` 返回 `409 + currentStatus=pending_review` 且调用方是 delegator，
- Gateway 会先自动执行 `reject`（回到 `processing`），再重试 `need-human-input`，
- 最终把任务修正到 `waiting_for_input`，避免流程卡死。

## Delegate-Intent 场景

委托方 proxy sub-session 的行为：
1. 收到 executor 的 DM 提问
2. 尝试从 intent 上下文中回答
3. 无法回答 → 调 `/need-human-input` 向自己的人类用户请求信息
4. 人类回复后，系统自动将 humanInput 投递给 executor（proxy 无需手动转发）
