# OpenClaw CLI 接口参考 — Gateway 可用命令

> ⚠️ Historical Notice: 本目录以背景资料/调研为主，不是当前实现规范。
> 当前规范请优先参考：`docs/spec/README.md` 与各域 canonical 文档。

本文档整理了 OpenClaw CLI 暴露的所有可被 ClawTeam Gateway 使用的命令行接口，
包括当前已使用的和尚未使用但可用的命令。

> **重要**: OpenClaw CLI 没有 `openclaw session`（单数）子命令。
> 只有 `openclaw sessions`（复数）和 `openclaw agent` 命令可用。
> 架构文档中提到的 `openclaw session send/status/restore` 命令不存在。

## 概念

| 概念 | 说明 |
|------|------|
| Session Key | 逻辑标识，格式 `agent:<agentId>:main` 或 `agent:<agentId>:subagent:<uuid>` |
| Session ID | 真实 UUID，存储在 `sessions.json` 中，CLI `--session-id` 参数接受此值 |
| Agent ID | 代理标识（如 `main`），从 session key 的第二段解析 |
| sessions.json | `~/.openclaw/agents/<agentId>/sessions/sessions.json`，key→UUID 映射 |

---

## 1. 消息发送

### 1.1 发送消息到指定 session（按 UUID）✅ 当前使用

```bash
openclaw agent --session-id <real-uuid> --message "<message>" --json
```

| 参数 | 说明 |
|------|------|
| `--session-id` | 真实 session UUID（非 session key） |
| `--message` | 消息内容 |
| `--json` | JSON 格式输出 |

行为：
- 将消息投递到指定 session，LLM 开始处理
- CLI 会阻塞直到 LLM 完成（`expectFinal: true`），期间无 stdout 输出
- Gateway 使用 fire-and-forget 模式：spawn 为 detached 进程，3 秒 grace period 后假定投递成功
- 需要先从 `sessions.json` 查找 session key 对应的 UUID

输出格式：
```json
{
  "result": {
    "payloads": [
      { "text": "..." }
    ]
  }
}
```

当前使用位置：
- `openclaw-session-cli.ts` → `sendToSession()` / `sendToMainSession()`

注意事项：
- 当同时传入 `--agent` 和 `--session-id` 时，CLI 忽略 `--session-id`，始终路由到 agent 的 main session
- 要发送到 sub-session，必须只传 `--session-id`，不传 `--agent`
- Windows 下需要 `shell: true` 并对引号做转义

### 1.2 快捷发送（当前 agent）

```bash
openclaw send "<message>"
```

发送消息到当前活跃 agent 的 main session。

当前使用位置：`clawteam-poller.sh`（外部脚本）

---

## 2. Session 查询

### 2.1 列出所有 session ✅ 当前使用

```bash
openclaw sessions --json
```

输出格式：
```json
{
  "sessions": [
    {
      "key": "agent:main:main",
      "sessionId": "a4b62ffb-a0a5-4c87-...",
      "ageMs": 12345,
      "updatedAt": 1707654321000
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `key` | Session key（逻辑标识） |
| `sessionId` | 真实 UUID |
| `ageMs` | 距上次更新的毫秒数 |
| `updatedAt` | 上次更新的 Unix 时间戳 |

当前使用位置：
- `openclaw-session-cli.ts` → `isSessionAlive()` — 判断 `ageMs < sessionAliveThresholdMs`（默认 24h）
- `session-status-resolver.ts` → `fetchCliSessions()` — 获取所有 session 状态，结合 JSONL 分析推导 session state
- `cli-status.ts` → TUI 展示

超时：10 秒

> **注意**: OpenClaw 没有单 session 查询命令（`openclaw session status` 不存在）。
> 所有 session 状态查询都通过 `openclaw sessions --json` 全量拉取后过滤。

---

## 3. Session 管理

### 3.1 重置 session（通过 gateway call）✅ 当前使用

```bash
openclaw gateway call sessions.reset --params '{"key":"agent:main:main"}' --json
```

输出格式：
```json
{
  "ok": true,
  "entry": {
    "sessionId": "<new-uuid>"
  }
}
```

行为：
- 归档旧的 JSONL transcript（重命名为 `.deleted.*`）
- 分配新的 session ID
- 返回新 session ID

当前使用位置：
- `openclaw-session-cli.ts` → `resetMainSession()`
- `router-api.ts` → `POST /sessions/main/reset`

超时：15 秒

### 3.2 恢复已归档 session — 文件系统直接操作

OpenClaw CLI 没有 session restore 命令。Gateway 通过直接操作文件系统实现：
1. 读取 `sessions.json` 查找 session UUID
2. 检查 `.jsonl` 文件是否存在
3. 查找 `.deleted.*` 归档文件并 rename 回 `.jsonl`
4. 更新 `sessions.json` 条目

当前使用位置：
- `openclaw-session-cli.ts` → `restoreSession()`

---

## 4. Agent 管理

### 4.1 列出所有 agent

```bash
openclaw agents list
```

### 4.2 创建 agent

```bash
openclaw agents add <name> --workspace <dir>
```

### 4.3 设置 agent identity

```bash
openclaw agents set-identity
```

### 4.4 删除 agent

```bash
openclaw agents delete <name>
```

当前使用位置：均无（Gateway 不管理 agent 生命周期）

---

## 5. Gateway 控制

### 5.1 启动 gateway

```bash
openclaw gateway
```

### 5.2 健康检查

```bash
openclaw gateway health --json
```

默认端口 18789。

### 5.3 通用 gateway call

```bash
openclaw gateway call <method> --params '<json>' --json
```

已知可用的 method：
- `sessions.reset` — 重置 session（见 3.1）

当前使用位置：`openclaw-session-cli.ts` → `resetMainSession()`

---

## 6. Cron 调度

```bash
openclaw cron list                  # 列出所有 cron job
openclaw cron enable <job-id>       # 启用
openclaw cron disable <job-id>      # 禁用
openclaw cron delete <job-id>       # 删除
openclaw cron trigger <job-id>      # 手动触发
openclaw cron history <job-id>      # 查看执行历史
```

当前使用位置：无（Gateway 不管理 cron）

注意：直接编辑 `~/.openclaw/cron/jobs.json` 无效，gateway 会用内存状态覆盖。

---

## 7. Hook 管理

```bash
openclaw hooks list                 # 列出所有 hook
openclaw hooks list --eligible      # 仅列出可用 hook
openclaw hooks list --verbose       # 详细信息
openclaw hooks info <hook-name>     # 查看特定 hook
openclaw hooks enable <hook>        # 启用
openclaw hooks disable <hook>       # 禁用
openclaw hooks install <source>     # 安装（npm/path/zip/tar）
openclaw hooks update               # 更新已安装 hook
```

当前使用位置：无

---

## 8. 其他命令

```bash
openclaw setup                      # 初始化 ~/.openclaw 和 agent workspace
openclaw reset                      # 重置本地 config/state（保留 CLI）
openclaw uninstall                  # 卸载 gateway + 本地数据（保留 CLI）
openclaw onboard                    # 运行 onboarding 向导
openclaw onboard --install-daemon   # 安装为 daemon（launchd/systemd）
openclaw skills list                # 列出所有 skill
openclaw security audit --deep      # 深度安全审计
openclaw security audit --fix       # 自动修复安全问题
openclaw --version                  # 查看版本
```

---

## 9. Gateway 当前使用的接口汇总

| 命令 | 用途 | 调用方 | 超时 |
|------|------|--------|------|
| `openclaw agent --session-id <uuid> --message "..." --json` | 发送消息到 session | `sendToSession()` / `sendToMainSession()` | 3s grace (detached) |
| `openclaw sessions --json` | 查询所有 session 状态 | `isSessionAlive()` / `fetchCliSessions()` | 10s |
| `openclaw gateway call sessions.reset --params '...' --json` | 重置 main session | `resetMainSession()` | 15s |

---

## 10. 文件系统直接操作（非 CLI）

Gateway 通过直接读写文件系统实现以下功能（OpenClaw CLI 无对应命令）：

| 操作 | 路径 | 用途 |
|------|------|------|
| 读取 sessions.json | `~/.openclaw/agents/<agentId>/sessions/sessions.json` | session key → UUID 映射查找（`sendToSession` 需要） |
| 读取 JSONL | `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl` | session-status-resolver 分析 session 状态 |
| 重命名 .deleted.* → .jsonl | 同上 | `restoreSession()` 恢复已归档 session |
| 写入 sessions.json | 同上 | `restoreSession()` 恢复 session 条目 |
| 扫描 agents 目录 | `~/.openclaw/agents/` | session-status-resolver / cli-status 发现所有 agent |

---

## 11. 不存在的命令（文档勘误）

以下命令在早期架构文档中被提及，但 OpenClaw CLI 实际不支持：

| 命令 | 状态 | 当前替代方案 |
|------|------|-------------|
| `openclaw session send --key "..."` | ❌ 不存在 | `openclaw agent --session-id <uuid>` + sessions.json 查找 |
| `openclaw session status --key "..."` | ❌ 不存在 | `openclaw sessions --json` 全量查询后过滤 |
| `openclaw session restore --key "..."` | ❌ 不存在 | 直接操作文件系统（rename + write） |

---

## 12. 配置

```yaml
# ~/.clawteam/config.yaml
openclaw:
  mode: cli              # cli | http
  bin: openclaw           # CLI 二进制路径（env: OPENCLAW_BIN）
  home: ~/.openclaw       # 数据目录（env: OPENCLAW_HOME）
  mainAgentId: main       # 主 agent ID（env: MAIN_AGENT_ID）
```

环境变量优先级：`env > yaml > default`
