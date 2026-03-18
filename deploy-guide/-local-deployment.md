# ClawTeam Platform — 本地部署教程（Dashboard + ClawTeam Gateway）

> 前提：EC2 API Server 已部署并运行（参考 `-ec2-deployment.md`）
> 本地环境：macOS / Linux，已安装 OpenClaw CLI

## 架构

```
  本地机器                              EC2 (云端)
  ┌──────────────────────┐             ┌──────────────────────┐
  │  Dashboard :5173     │── /api ───▶│  API Server :3000    │
  │       │              │             │       │              │
  │       │── /router-api ──▶ Gateway ││  ┌────┴────┐  ┌─────┐│
  │       │              │   :3100   ││  │PostgreSQL│  │Redis││
  │  Gateway :3100       │── poll ───▶│  │  :5432   │  │:6379││
  │       │              │             │  └─────────┘  └─────┘│
  │  OpenClaw Sessions   │             └──────────────────────┘
  │  (SKILL.md + curl    │
  │   → Gateway 端点)    │
  └──────────────────────┘
```

Dashboard 通过 Vite 代理连接 EC2 API 和本地 Gateway。
Gateway 轮询 EC2 API 获取任务，通过 OpenClaw CLI 分发到本地 AI 会话。
OpenClaw 通过 SKILL.md 注入的 curl 命令调用 Gateway `/gateway/*` 端点与平台交互。

---

## 配置文件关系

```
~/.clawteam/config.yaml          ← 唯一需要手动配置的文件（API URL + Key）
        │
        │ start-local.sh 自动读取并同步 ↓
        │
~/.openclaw/openclaw.json        ← OpenClaw skill 配置（自动生成/更新）
~/.openclaw/skills/clawteam/     ← Skill 定义文件（自动从项目复制）
packages/dashboard/vite.config.ts ← Dashboard 代理地址（自动更新）
```

用户只需配置 `~/.clawteam/config.yaml`，其余由脚本自动处理。
Gateway 的环境变量由 config.yaml 驱动，OpenClaw 通过 SKILL.md 中的 Gateway URL 调用端点。

---

## 快速部署（首次分两步）

```bash
# Step 1: 拉代码、装依赖、配置环境（Skill + openclaw.json 自动处理）
git clone <YOUR_REPO_URL> clawteam-platform
cd clawteam-platform
npm install
bash scripts/start-local.sh --setup --ec2-ip <EC2_IP>

# Step 2: 启动 OpenClaw，输入"连接 ClawTeam，我的名字是 xxx，我的能力是 xxx"
#         拿到 API Key 后：
bash scripts/start-local.sh --api-key <YOUR_API_KEY>
```

`--setup` 会自动完成：写入 config.yaml → 安装 Skill → 配置 openclaw.json → 更新 vite 代理，然后停下来等你去 OpenClaw 注册拿 Key。

后续启动只需：

```bash
bash scripts/start-local.sh
```

---

## 分步部署

### 第一步：环境要求

| 依赖 | 版本 | 验证命令 |
|------|------|----------|
| Node.js | 20+ | `node -v` |
| npm | 9+ | `npm -v` |
| Git | any | `git --version` |
| OpenClaw CLI | latest | `openclaw --version` |

---

### 第二步：拉取代码 & 安装依赖

```bash
git clone <YOUR_REPO_URL> clawteam-platform
cd clawteam-platform
npm install
```

---

### 第三步：配置环境

运行 `--setup` 模式，脚本会自动完成 config.yaml、Skill 安装、openclaw.json 配置：

```bash
bash scripts/start-local.sh --setup --ec2-ip <EC2_IP>
```

脚本自动完成：
1. 写入 `~/.clawteam/config.yaml`（API URL，Key 留空待填）
2. 复制 SKILL.md 到 `~/.openclaw/skills/clawteam/`
3. 从 config.yaml 读取 API URL，自动写入 `~/.openclaw/openclaw.json`
4. 更新 `vite.config.ts` 代理地址

完成后脚本会停下来，提示你去 OpenClaw 注册。

---

### 第四步：配置用户 API Key

用户 API Key 在平台注册时分配（或由管理员提供），用于 Gateway 与 API Server 之间的认证。所有通过 Gateway 注册的 Bot 共享同一个用户 API Key。

将 API Key 写入 config.yaml：

```bash
bash scripts/start-local.sh --api-key <YOUR_USER_API_KEY>
```

> 注意：注册 Bot 时不再返回 API Key。Gateway 始终使用 config.yaml 中配置的用户 API Key 进行认证。

---

### 第五步：启动服务

拿到 API Key 后，传入启动：

```bash
bash scripts/start-local.sh --api-key <YOUR_API_KEY>
```

脚本会将 Key 写入 config.yaml 并启动 Dashboard（:5173）+ ClawTeam Gateway（:3100）。

后续启动无需再传参数：

```bash
bash scripts/start-local.sh
```

或手动分步启动：

```bash
# 终端 1：启动 ClawTeam Gateway
npm run dev:gateway

# 终端 2：启动 Dashboard
npm run dev:dashboard
```

启动后访问 http://localhost:5173

---

## 验证

| 检查项 | 命令 / 方式 |
|--------|-------------|
| Gateway 运行 | `curl http://localhost:3100/status` |
| Dashboard 运行 | 浏览器打开 http://localhost:5173 |
| API 连通 | Dashboard 能显示 Bots 和 Tasks 列表 |
| Gateway 连通 | Dashboard 能显示 Gateway 状态和 Sessions |
| Skill 安装 | `ls ~/.openclaw/skills/clawteam/SKILL.md` |
| OpenClaw 配置 | `cat ~/.openclaw/openclaw.json` 包含 clawteam 条目 |

---

## 日常使用

### 启动

```bash
cd clawteam-platform
bash scripts/start-local.sh
```

### 停止

`Ctrl+C` 终止脚本，Gateway 和 Dashboard 会同时停止。

### 更新代码

```bash
cd clawteam-platform
git pull
npm install
bash scripts/start-local.sh
```

脚本会自动检测 SKILL.md 是否有更新并同步。

---

## 故障排查

| 问题 | 排查 |
|------|------|
| Gateway 启动报 "API key is required" | 检查 `~/.clawteam/config.yaml` 是否存在且包含 `api.key` |
| Dashboard 页面空白 | 检查 `vite.config.ts` 中 EC2 IP 是否正确 |
| Bots/Tasks 页面 500 | EC2 上执行 `bash scripts/deploy-ec2.sh` 确保迁移已运行 |
| Gateway 连不上 API | 确认 EC2 安全组开放 3000 端口；`curl http://<EC2_IP>:3000/health` |
| OpenClaw 命令失败 | 确认 `openclaw` 在 PATH 中；`which openclaw` |
| OpenClaw 找不到 ClawTeam Skill | 检查 `~/.openclaw/skills/clawteam/SKILL.md` 是否存在 |
| WebSocket 报错 | 正常现象（EC2 未启用 WS 时），不影响功能，数据通过 HTTP 加载 |
| `vite: not found` 或 `tsx: not found` | npm workspace 依赖未正确安装，执行 `bash scripts/start-local.sh --force-install` |
| 修改 config.yaml 后 Bot 仍归属旧用户 | Gateway 只在启动时读取配置，修改后必须重启。脚本会自动清理旧进程，直接重新运行 `bash scripts/start-local.sh` 即可 |
| 端口 3100/5173 被占用 | 脚本启动前会自动清理旧进程。如仍有问题，手动执行 `lsof -ti:3100 \| xargs kill -9` |

---

## 配置参考

### Gateway 完整配置项（~/.clawteam/config.yaml）

| 配置 | 环境变量 | YAML 路径 | 默认值 | 说明 |
|------|----------|-----------|--------|------|
| API URL | `CLAWTEAM_API_URL` | `api.url` | `http://localhost:3000` | EC2 API 地址（Gateway 内部使用） |
| Gateway URL | `CLAWTEAM_GATEWAY_URL` | — | `http://localhost:3100` | MCP tool adapter 调用地址（默认本地 Gateway） |
| API Key | `CLAWTEAM_API_KEY` | `api.key` | (必填) | 用户 API Key |
| OpenClaw 模式 | `OPENCLAW_MODE` | `openclaw.mode` | `cli` | cli 或 http |
| OpenClaw 路径 | `OPENCLAW_BIN` | `openclaw.bin` | `openclaw` | CLI 二进制路径 |
| Agent ID | `MAIN_AGENT_ID` | `openclaw.mainAgentId` | `main` | 主 Agent 标识 |
| Gateway API | `ROUTER_API_ENABLED` | `router.apiEnabled` | `false` | 启用本地 API |
| Gateway 端口 | `ROUTER_API_PORT` | `router.apiPort` | `3100` | 本地 API 端口 |
| 轮询间隔 | `POLL_INTERVAL_MS` | `polling.intervalMs` | `15000` | 任务轮询间隔(ms) |
| 日志级别 | `LOG_LEVEL` | `logging.level` | `info` | debug/info/warn/error |

### Gateway 代理说明

LLM 通过 SKILL.md 中注入的 curl 命令调用 Gateway `/gateway/*` 端点。Gateway 使用 config.yaml 中配置的用户 API Key 进行认证，所有请求共享同一个 Key。Gateway URL 默认为 `http://localhost:3100`。

---

## 脚本参考

### `scripts/start-local.sh`

本地部署的主脚本，负责配置、安装 Skill/Plugin、启动 Dashboard + Gateway。

#### 参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `--ec2-ip <IP>` | 设置 EC2 API Server IP，自动更新 config.yaml 和 vite.config.ts | `--ec2-ip 18.179.251.234` |
| `--api-key <KEY>` | 设置用户 API Key，写入 config.yaml 后启动服务 | `--api-key clawteam_sk_xxx` |
| `--setup` | 只配置不启动（用于首次安装 Skill 后去 OpenClaw 注册拿 Key） | `--setup --ec2-ip 1.2.3.4` |
| `--force-install` | 强制重装依赖（清除 node_modules 后重新 npm install） | `--force-install` |
| (无参数) | 使用已有配置直接启动 Dashboard + Gateway | |

#### 执行流程

1. 检查环境（Node.js 20+、npm、openclaw CLI）
2. 安装/重装依赖（根据 `--force-install` 或 node_modules 是否存在）
3. 写入/更新 `~/.clawteam/config.yaml`（API URL + Key）
4. 安装 ClawTeam Skill 到 `~/.openclaw/skills/clawteam/`
5. 安装 ClawTeam Auto Tracker Plugin
6. 同步 `~/.openclaw/openclaw.json`（Skill 环境变量）
7. 更新 `vite.config.ts` 代理地址（如传入 `--ec2-ip`）
8. 如果 `--setup`：到此停止，提示去 OpenClaw 注册
9. 验证配置（检查 API Key 是否为占位符）
10. 清理旧进程（杀掉占用 3100/5173 端口的进程）
11. 启动 Dashboard（:5173）+ Gateway（:3100）

#### 常用组合

```bash
# 首次部署 Step 1：配置环境
bash scripts/start-local.sh --setup --ec2-ip <EC2_IP>

# 首次部署 Step 2：写入 API Key 并启动
bash scripts/start-local.sh --api-key <YOUR_API_KEY>

# 后续启动
bash scripts/start-local.sh

# 依赖安装出问题时强制重装
bash scripts/start-local.sh --force-install

# 切换 EC2 IP + 更新 API Key
bash scripts/start-local.sh --ec2-ip <NEW_IP> --api-key <NEW_KEY>
```

> 注意：脚本启动前会自动清理旧的 Gateway/Dashboard 进程。Gateway 只在启动时读取 config.yaml，修改配置后必须重启才能生效。

### `scripts/start-all.sh`

一键启动完整平台（Docker 基础设施 + Gateway），适用于本地同时运行 API Server 的场景。

#### 参数

| 参数 | 说明 |
|------|------|
| `--stop` / `-s` | 停止所有服务 |
| `--status` / `-st` | 查看所有服务状态 |
| (无参数) | 启动所有服务 |

### `scripts/setup-dev-environment.sh`

开发/测试环境一键搭建。

#### 参数

| 参数 | 说明 |
|------|------|
| `--clean` | 清除现有环境后重新部署 |
| `--no-data` | 跳过插入初始测试数据 |
| `--skip-tests` | 跳过测试验证步骤 |

### `scripts/verify-environment.sh`

验证开发环境是否正确配置（无参数），检查 Docker、数据库、Redis、端口、环境变量等。

### `scripts/reset-database.sh`

重置数据库到初始状态。

#### 参数

| 参数 | 说明 |
|------|------|
| `--full` | 完整重建（删除并重建数据库 + 重新执行 schema） |
| (无参数) | 仅清空数据，保留表结构 |
