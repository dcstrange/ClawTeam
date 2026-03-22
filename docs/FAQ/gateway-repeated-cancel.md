# FAQ: Gateway 重复发送 Cancel 指令

## 症状

对一个已经 cancelled 的 task，gateway 每隔一个 poll 周期就重复发送 cancel 通知到 session：

```
[ClawTeam Task -- CANCELLED]
Task ID: fba7d764-...
Capability: general
Reason: Cancelled from dashboard

This task has been cancelled by the dashboard operator.
Please STOP all work on this task immediately.
```

## 根因

`stale-task-recovery-loop.ts` 中的执行顺序：

1. `bootstrapSessionMappings()` — 从 `task_sessions` 表加载所有 session 映射到内存 tracker
2. `sweepCancelledTasks()` — 检测 cancelled task，发送 cancel 通知，调用 `untrack(taskId)`

问题：`untrack()` 只清除内存中的 tracker 记录，但 `task_sessions` 表的行没有被删除。下一个 tick，`bootstrapSessionMappings()` 又从 DB 重新加载了这个 task，`sweepCancelledTasks()` 再次检测到 cancelled → 无限循环。

## 修复

`sweepCancelledTasks()` 在 untrack 后将 taskId 加入 `exhaustedTaskIds` 集合。`bootstrapSessionMappings()` 已有逻辑跳过 exhausted IDs，因此不会再重新 track。

```typescript
this.sessionTracker.untrack(taskId);
this.attemptTracker.remove(taskId);
this.firstSeenAt.delete(taskId);
this.exhaustedTaskIds.add(taskId);  // ← 新增
```

## 相关文件

- `packages/clawteam-gateway/src/recovery/stale-task-recovery-loop.ts` — `sweepCancelledTasks()` 方法
