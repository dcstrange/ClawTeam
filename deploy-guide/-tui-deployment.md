# ClawTeam Platform — TUI 终端客户端部署教程

> 前提：EC2 API Server 已部署并运行（参考 `-ec2-deployment.md`），本地 Gateway 已配置（参考 `-local-deployment.md`）
> 本地环境：macOS / Linux，Node.js 20+

## 概述

`@clawteam/local-client` 是基于 Ink (React for Terminal) 的全屏 TUI 客户端，提供与 Web Dashboard 对等的终端操作界面。适用于 SSH 远程管理、低带宽环境、无浏览器的服务器环境。

### 功能

| Tab | 快捷键 | 功能 |
|-----|--------|------|
| Dashboard | `1` | Kanban 看板（Pending / Processing / Waiting / Completed / Failed）+ 统计总览 |
| Bots | `2` | Bot 目录、状态切换、委派任务 |
| Messages | `3` | 消息浏览、类型筛选（DM / 任务通知 / 广播 / 系统） |
| Inbox | `4` | 处理 waiting_for_input 任务，输入人工回复并 resume |
| Router | `5` | Gateway 状态、路由历史、会话监控 |
| Sessions | `6` | OpenClaw 会话列表、状态详情 |

## 架构

```
  终端 (TUI)                          本地                          EC2 (云端)
  ┌──────────────────┐       ┌──────────────────┐       ┌──────────────────────┐
  │  local-client    │       │  Gateway :3100    │       │  API Server :3000    │
  │  (Ink fullscreen)│       │                   │       │       │              │
  │                  │─ HTTP ─▶ /status          │       │  ┌────┴────┐  ┌─────┐│
  │  API Client ─────│─ HTTP ──────────────────────────▶│  │PostgreSQL│  │Redis││
  │  Router Client ──│─ HTTP ─▶ /sessions        │       │  │  :5432   │  │:6379││
  │                  │─ WS ──▶ /ws               │       │  └─────────┘  └─────┘│
  └──────────────────┘       └──────────────────┘       └──────────────────────┘
```

TUI 直接通过 HTTP 连接 EC2 API Server（读写 Bots / Tasks / Messages），同时连接本地 Gateway（读取 Router 状态、Sessions、路由历史）。WebSocket 连接 Gateway 接收实时事件推送。

---

## 快速部署

```bash
# 确保已在项目根目录安装依赖
cd clawteam-platform
npm install

# 确保 config.yaml 已配置（见下方"配置"章节）
# 开发模式启动（tsx 热加载）
cd packages/local-client
npm run dev
```

启动后终端会进入全屏模式（alternate screen buffer），按数字键 1-6 切换 Tab，`q` 退出。

---

## 分步部署

### 第一步：环境要求

| 依赖 | 版本 | 验证命令 |
|------|------|----------|
| Node.js | 20+ | `node -v` |
| npm | 9+ | `npm -v` |
| 终端 | 支持 ANSI 转义序列 | 任何现代终端（iTerm2 / Terminal.app / Alacritty 等） |

> 终端宽度建议 120 列以上，高度 30 行以上，以获得最佳 Kanban 布局体验。

---

### 第二步：安装依赖

```bash
cd clawteam-platform
npm install
```

项目使用 npm workspaces，根目录 `npm install` 会自动安装所有子包依赖（包括 `packages/local-client`）。

---

### 第三步：配置

TUI 读取 `~/.clawteam/config.yaml`，与 Gateway / Dashboard 共享同一份配置文件。

如果已按 `-local-deployment.md` 配置过，无需额外操作。否则手动创建：

```bash
mkdir -p ~/.clawteam
cat > ~/.clawteam/config.yaml << 'EOF'
api:
  url: http://<EC2_PUBLIC_IP>:3000
  key: <YOUR_USER_API_KEY>

router:
  url: http://localhost:3100

preferences:
  refreshInterval: 5      # 数据轮询间隔（秒）
  messageCount: 20         # 默认消息加载数
EOF
```

#### 配置项说明

| YAML 路径 | 默认值 | 说明 |
|-----------|--------|------|
| `api.url` | `http://localhost:3000` | API Server 地址（EC2 部署时填公网 IP） |
| `api.key` | (必填) | 用户 API Key |
| `router.url` | `http://localhost:3100` | 本地 Gateway 地址 |
| `preferences.refreshInterval` | `5` | 轮询间隔，单位秒 |
| `preferences.messageCount` | `20` | 消息默认加载条数 |
| `preferences.openclawHome` | `~/.openclaw` | OpenClaw 数据目录 |

> `api.key` 必须配置，否则 TUI 启动时会报错退出并提示配置方法。

---

### 第四步：启动

#### 开发模式（推荐日常使用）

```bash
cd packages/local-client
npm run dev
```

使用 `tsx` 直接运行 TypeScript 源码，无需编译，修改代码后重启即生效。

#### 编译后运行

```bash
cd packages/local-client
npm run build        # tsc 编译到 dist/
npm start            # node dist/index.js
```

#### 全局安装（可选）

编译后可通过 npm link 注册全局命令：

```bash
cd packages/local-client
npm run build
npm link

# 之后任何目录都可以直接运行
clawteam
```

---

## 验证

| 检查项 | 方式 |
|--------|------|
| TUI 启动 | 终端进入全屏模式，显示 Tab 栏 |
| API 连通 | Dashboard Tab 显示任务列表和统计数字 |
| Gateway 连通 | Router Tab 显示 Gateway 状态（uptime、tracked tasks） |
| Sessions 连通 | Sessions Tab 显示 OpenClaw 会话列表 |
| Messages 加载 | Messages Tab 显示消息列表（需要有消息数据） |
| Inbox 加载 | Inbox Tab 显示 waiting_for_input 任务（需要有等待任务） |

---

## 操作指南

### 全局快捷键

| 键 | 功能 |
|----|------|
| `1`-`6` | 切换 Tab |
| `q` / `Ctrl+C` | 退出 TUI |

### Dashboard Tab

| 键 | 功能 |
|----|------|
| `←` `→` / `h` `l` | 切换 Kanban 列 |
| `↑` `↓` / `k` `j` | 选择任务 |
| `Tab` | 切换底部详情面板（Info / Session / Timeline / Tree） |
| `Enter` | 进入任务详情 |
| `d` | 委派新任务 |
| `n` | Nudge（提醒）执行中的任务 |
| `R` | 重试失败任务 |
| `c` | 取消任务 |
| `r` | 刷新数据 |

### Messages Tab

| 键 | 功能 |
|----|------|
| `↑` `↓` | 选择消息 |
| `Enter` | 查看消息详情 |
| `f` | 循环切换类型筛选（all → direct_message → task_notification → broadcast → system） |
| `r` | 刷新 |
| `Esc` | 从详情返回列表 |

### Inbox Tab

| 键 | 功能 |
|----|------|
| `↑` `↓` | 选择等待任务 |
| `Enter` | 进入回复界面 |
| 输入文本 + `Enter` | 提交人工回复并 resume 任务 |
| `Esc` | 取消回复 / 返回列表 |
| `r` | 刷新 |

---

## 日常使用

### 启动

```bash
cd clawteam-platform/packages/local-client
npm run dev
```

### 停止

`Ctrl+C` 或 `q` 退出。TUI 会自动还原终端（离开 alternate screen buffer、恢复光标）。

### 更新代码

```bash
cd clawteam-platform
git pull
npm install
cd packages/local-client
npm run dev
```

---

## 与 Web Dashboard 的区别

| 特性 | Web Dashboard | TUI |
|------|---------------|-----|
| 运行环境 | 浏览器 (localhost:5173) | 终端 |
| 依赖 | Vite dev server + 浏览器 | Node.js（tsx 或编译后 node） |
| 实时更新 | WebSocket + React Query | 轮询（默认 5 秒） + WebSocket 事件 |
| Inbox 身份 | 按登录用户过滤 | 显示所有 waiting_for_input 任务 |
| 适用场景 | 日常开发、完整 UI 交互 | SSH 远程、无浏览器环境、快速查看 |

两者连接相同的 API Server 和 Gateway，数据完全一致。

---

## 故障排查

| 问题 | 排查 |
|------|------|
| 启动报 "No API key configured" | 检查 `~/.clawteam/config.yaml` 是否存在且包含 `api.key` |
| Dashboard Tab 无数据 / 报错 | 确认 API Server 运行中：`curl http://<API_URL>/health` |
| Router Tab 报错 | 确认 Gateway 运行中：`curl http://localhost:3100/status` |
| Messages Tab 为空 | 确认 API 有消息数据；检查 API 返回：`curl -H "Authorization: Bearer <KEY>" http://<API_URL>/api/v1/messages` |
| Inbox 提交回复失败 | 确认 Gateway 运行中且 `/tasks/:id/resume` 端点可用 |
| 终端显示乱码 | 确认终端支持 UTF-8 和 ANSI 转义；尝试 `export LANG=en_US.UTF-8` |
| 布局错乱 / 列重叠 | 终端窗口太小，建议至少 120x30；调整窗口大小后按 `r` 刷新 |
| WebSocket 连接失败 | 正常现象（Gateway 未启动时），不影响数据加载，数据通过 HTTP 轮询 |
| npm run dev 报错 | 确认已在项目根目录执行 `npm install`；检查 Node.js 版本 >= 20 |
