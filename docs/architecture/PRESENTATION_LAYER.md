# 展示层 — @clawteam/dashboard + @clawteam/local-client

> 两种监控和管理界面：Web Dashboard 和终端 TUI

## 1. 概述

| 模块 | 技术栈 | 端口 | 适用场景 |
|------|--------|------|---------|
| dashboard | React 18 + Vite 5 + TailwindCSS 3 | 5173 (dev) / 80 (prod) | 浏览器全功能监控 |
| local-client | Ink 5 (React for CLI) | - | 终端快速查看 |

两者都连接 API Server (:3000) 和 ClawTeam Gateway (:3100)，通过 HTTP 获取数据、WebSocket 接收实时事件。

---

## 2. dashboard — Web 监控面板

### 2.1 目录结构

```
packages/dashboard/src/
├── App.tsx                      # 路由定义 (React Router 6)
├── main.tsx                     # 入口
├── lib/
│   ├── config.ts                # API URL 配置
│   ├── types.ts                 # 前端类型定义
│   ├── router-api.ts            # Router HTTP 客户端
│   └── file-download.ts         # 文件下载与 ZIP 打包能力
├── hooks/
│   ├── useWebSocket.ts          # API Server WebSocket (任务/Bot 事件)
│   ├── useRouterWebSocket.ts    # Router WebSocket (路由/session 事件)
│   └── useRouterStatus.ts       # Router 状态轮询
├── components/
│   ├── Navbar.tsx               # 顶部导航栏
│   ├── TaskCard.tsx             # 任务卡片
│   ├── TaskKanban.tsx           # 看板视图
│   ├── TaskTree.tsx             # 依赖树视图
│   ├── TaskActions.tsx          # 任务操作 (cancel/retry/nudge)
│   ├── TaskFilesPanel.tsx       # 任务文件面板（上传/下载/发布/移动/复制/删除）
│   └── ConfirmModal.tsx         # 确认对话框
└── pages/
    ├── Dashboard.tsx            # 首页概览
    ├── TaskList.tsx             # 任务列表 + 看板
    ├── TaskDetail.tsx           # 任务详情
    ├── CloudFiles.tsx           # 云文件页（private/public/team/task 视图）
    ├── SessionList.tsx          # Session 列表
    └── RouteHistory.tsx         # 路由历史
```

### 2.2 数据获取策略

**React Query + 双 WebSocket：**

```
                    ┌─ useWebSocket (ws://api:3000/ws)
                    │   → task_assigned/completed/failed → invalidate(['tasks'])
                    │   → bot_status_changed → invalidate(['bots'])
React Query Cache ──┤
                    │
                    └─ useRouterWebSocket (ws://router:3100/ws)
                        → task_routed → invalidate(['router-route-history'], ['tasks'])
                        → session_state_changed → invalidate(['router-sessions'])
                        → poll_complete → invalidate(['router-status'])
```

**查询 Key 映射：**

| Key | 数据源 | 刷新触发 |
|-----|--------|---------|
| `['tasks']` | GET /api/v1/tasks/all | task_assigned, task_completed, task_routed, poll_complete |
| `['bots']` | GET /api/v1/bots | bot_status_changed |
| `['router-status']` | GET router:3100/status | poll_complete |
| `['router-sessions']` | GET router:3100/sessions | session_state_changed |
| `['router-route-history']` | GET router:3100/routes/history | task_routed |

### 2.3 页面功能

| 页面 | 路径 | 功能 |
|------|------|------|
| Dashboard | `/` | 任务统计、Bot 状态、最近活动 |
| TaskList | `/tasks` | 列表/看板视图切换、状态过滤、搜索 |
| TaskDetail | `/tasks/:id` | 详情、参数、结果、依赖树、消息历史、任务文件 |
| CloudFiles | `/files` | 统一文件空间（private/public/team/task），支持批量选择与 ZIP 下载预览 |
| SessionList | `/sessions` | 活跃 session、状态、关联任务 |
| RouteHistory | `/routes` | 路由历史、成功/失败统计 |

### 2.4 部署

**nginx 反向代理 (生产)：**

```nginx
# API 代理
location /api/ {
    proxy_pass http://api:3000/api/;
}

# WebSocket 代理
location /ws {
    proxy_pass http://api:3000/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}

# Router 代理
location /router-ws {
    proxy_pass http://router:3100/ws;
    # ... WebSocket headers
}

# SPA fallback
location / {
    try_files $uri $uri/ /index.html;
}
```

---

## 3. local-client — 终端 TUI

### 3.1 目录结构

```
packages/local-client/src/
├── index.tsx                    # 入口，加载配置并启动 Ink app
├── views/
│   ├── App.tsx                  # Tab 切换容器 (4 tabs)
│   ├── DashboardView.tsx        # Tab 1: 任务概览 + 看板
│   ├── BotListView.tsx          # Tab 2: Bot 目录
│   ├── RouterView.tsx           # Tab 3: 实时路由事件流
│   ├── SessionView.tsx          # Tab 4: Session 状态
│   └── TaskDetailView.tsx       # 任务详情 (从 Dashboard 进入)
├── components/
│   └── TaskRow.tsx              # 任务行组件
└── api/
    ├── clawteam-client.ts       # API Server HTTP 客户端
    └── router-client.ts         # Router HTTP + WebSocket 客户端
```

### 3.2 四 Tab 界面

```
┌─ Dashboard ─┬─ Bots ─┬─ Router ─┬─ Sessions ─┐
│                                                │
│  [Tab 1] 任务看板                               │
│  ┌────────┬──────────┬───────────┬──────────┐  │
│  │Pending │ Accepted │Processing │Completed │  │
│  ├────────┼──────────┼───────────┼──────────┤  │
│  │task-1  │task-3    │task-5     │task-7    │  │
│  │task-2  │          │task-6     │task-8    │  │
│  └────────┴──────────┴───────────┴──────────┘  │
│                                                │
│  ← → 切换 Tab | ↑↓ 选择 | Enter 详情 | q 退出  │
└────────────────────────────────────────────────┘
```

### 3.3 Router 事件流

RouterView 通过 WebSocket 实时显示路由事件：

```
[14:30:01] task_routed    task-abc → main     ✓ new task
[14:30:15] poll_complete  fetched:2 routed:1 failed:0
[14:30:32] session_state  task-abc  agent:main:sub-x  active
[14:32:01] session_state  task-abc  agent:main:sub-x  idle
```

### 3.4 配置

`~/.clawteam/config.yaml` (与 clawteam-gateway 共享):

```yaml
api:
  url: http://localhost:3000
  key: clawteam_xxx
router:
  url: http://localhost:3100
preferences:
  refreshInterval: 5    # 秒
  messageCount: 20       # 事件流显示条数
```

---

## 4. 功能对比

| 功能 | Dashboard (Web) | Local Client (TUI) |
|------|----------------|-------------------|
| 任务列表 | ✅ 列表 + 看板 | ✅ 看板 |
| 任务详情 | ✅ 完整 (参数/结果/依赖树) | ✅ 基本 |
| 任务操作 | ✅ cancel/retry/nudge | ❌ |
| Bot 目录 | ✅ | ✅ |
| Session 监控 | ✅ | ✅ |
| 路由历史 | ✅ 表格 | ✅ 实时流 |
| 实时更新 | ✅ 双 WebSocket | ✅ WebSocket + 轮询 |
| 部署要求 | 浏览器 | 终端 |
| 适用场景 | 全功能管理 | 快速查看 |

---

## 5. 已知限制

- Dashboard admin 端点无鉴权
- Local Client 不支持任务操作 (cancel/retry)
- 两者都不支持多 Router 实例
- Dashboard 的 nginx 配置需要手动匹配后端地址
- Dashboard 批量下载 ZIP 当前为前端打包（浏览器侧），尚无后端批量 ZIP 端点
