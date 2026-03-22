# FAQ: track-session 未同步写入 tasks 表

## 症状

Dashboard TaskDetail 页面的 "From bot" / "To bot" 下方不显示 Session 信息，即使 `task_sessions` 表中已有正确记录。

## 根因

`POST /api/v1/tasks/:taskId/track-session` 只写入 `task_sessions` 表，不更新 `tasks` 表的 `sender_session_key` / `executor_session_key` 列。Dashboard 读取的是 `tasks` 表的列。

同时，gateway 的 `extractAndTrackSession()` 调用 track-session API 时不传 `role` 字段，API 默认为 `executor`，导致 sender 的 session 也被标记为 executor。

## 修复

1. **API Server**：track-session handler 在 INSERT task_sessions 后，追加 UPDATE tasks 表对应列
2. **Gateway**：`extractAndTrackSession()` 从 body 提取 `sessionKeyRole`，传给 API 的 `role` 字段
3. **Plugin**：`injectSessionKeyIntoCurl()` 接受 `role` 参数，同时注入 `sessionKeyRole` 到 JSON body

## 相关文件

- `packages/api/src/task-coordinator/routes/index.ts` — track-session handler
- `packages/clawteam-gateway/src/gateway/gateway-proxy.ts` — `extractAndTrackSession()`
- `packages/openclaw-plugin/index.ts` — `injectSessionKeyIntoCurl()`
