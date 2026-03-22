# FAQ: Plugin 未注入角色模版（task_system_prompt_executor/sender.md）

## 症状

Executor 或 Sender 的 sub-session 初始 prompt 中只有原始任务内容，没有被 `task_system_prompt_executor.md` / `task_system_prompt_sender.md` 的内容包裹。

例如 executor sub-session 看到的是：
```
Delegate a task to bot xxx:
  Prompt: 写一个插入排序算法
  Priority: normal
  Capability: general
```

而不是预期的包含 ClawTeam 执行规则的完整 system prompt。

## 排查步骤

### 1. 确认 plugin 是否加载

检查远程机器的 `~/.openclaw/openclaw.json`：

```bash
cat ~/.openclaw/openclaw.json | grep -A5 '"load"'
```

必须包含 `plugins.load.paths` 指向 plugin 源码目录：

```json
"plugins": {
  "load": {
    "paths": ["/path/to/ClawTeam/packages/openclaw-plugin"]
  },
  "allow": ["clawteam-auto-tracker"]
}
```

如果只有 `plugins.allow` 而没有 `plugins.load.paths`，OpenClaw 会尝试从 `~/.openclaw/extensions/clawteam-auto-tracker/` 加载——那里可能是旧版本的 copy。

**修复**：重新运行 `bash scripts/start-local.sh --setup`，脚本已修复会自动写入 `load.paths`。

### 2. 确认 plugin 版本是否最新

如果 `load.paths` 指向 git repo 源码目录，代码修改会立即生效（无需重装）。

如果指向 `~/.openclaw/extensions/` 下的 copy，需要重新安装：
```bash
bash scripts/start-local.sh --setup
```

### 3. 确认 marker token 是否被正确解析

Plugin 通过 `<!--CLAWTEAM:{...}-->` 结构化 token 识别 ClawTeam spawn。检查 sub-session 初始消息中是否包含该 token。

已知会干扰解析的情况（均已修复）：
- Session 系统在行首添加 `[timestamp]` 前缀 → regex 已兼容
- LLM 改写或省略 plain-text marker → 改用 HTML comment 格式的 JSON token，LLM 不会改写
- 5 空格缩进导致 `^Role:` 不匹配 → 已移除缩进，改用 `---TASK VALUE START/END---` 分隔符

### 4. 查看 plugin 日志

Plugin 的 `console.log` 输出到 bot 进程的 stderr。启动 bot 时重定向 stderr 可以看到诊断日志：

```bash
openclaw ... 2>bot-debug.log
tail -f bot-debug.log | grep clawteam-auto-tracker
```

关键日志行：
- `sessions_spawn detected, task length=...` — plugin 的 before_tool_call 被触发
- `parseTaskMarkers result: {...}` — marker 解析结果
- `returning injected params, task length=...` — 模版注入成功

如果完全没有这些日志，说明 plugin 未被加载。

## 根因总结

| 问题 | 原因 | 修复 |
|------|------|------|
| 远程机器 plugin 未生效 | `openclaw.json` 缺少 `plugins.load.paths`，加载了 extensions 目录下的旧 copy | `start-local.sh` 已修复，重新 `--setup` |
| Marker 解析失败 | Session 系统添加 `[timestamp]` 前缀破坏 `^Role:` regex | 改用 `<!--CLAWTEAM:{...}-->` 结构化 token |
| LLM 省略 marker 行 | 5 空格缩进 + "去掉前导空格" 指令，LLM 直接重写了整段内容 | 改用 START/END 分隔符 + HTML comment token |
