# 部署指南

> 本地开发、Docker 生产、Kubernetes 部署

## 1. 本地开发环境

### 基础设施

```bash
# 启动 PostgreSQL + Redis
docker compose up postgres redis -d

# 初始化数据库
npm run migrate:up
```

### 服务启动

```bash
# 各终端分别启动
cd packages/api && npm run dev           # :3000
cd packages/clawteam-gateway && npm run dev   # :3100
cd packages/dashboard && npm run dev     # :5173

# 或使用脚本
./scripts/setup-dev-environment.sh
```

---

## 2. Docker 生产部署

### docker-compose 完整启动

```bash
docker compose --profile production up -d
```
单独重启dashboard：
```
docker compose --profile production up -d --build dashboard 2>&1
```

包含：
- PostgreSQL :5432
- Redis :6379
- API Server :3000
- Dashboard :80 (nginx)

### 环境变量

| 变量 | 服务 | 默认值 | 说明 |
|------|------|--------|------|
| `DATABASE_URL` | api | `postgresql://clawteam:changeme@localhost:5432/clawteam` | PostgreSQL 连接 |
| `REDIS_URL` | api | `redis://localhost:6379` | Redis 连接 |
| `PORT` / `API_PORT` | api | `3000` | HTTP 端口（两者均可） |
| `CORS_ORIGIN` | api | `http://localhost:5173` | CORS 允许来源（`*` 表示全部） |
| `LOG_LEVEL` | api, router | `info` | 日志级别 |
| `USE_MOCK` | api | `false` | 使用 Mock 实现 |
| `CLAWTEAM_API_URL` | gateway | `http://localhost:3000` | API Server 地址 |
| `CLAWTEAM_API_KEY` | gateway | - | 用户 API Key |
| `OPENCLAW_MODE` | gateway | `cli` | OpenClaw 模式 |
| `OPENCLAW_HOME` | gateway | `~/.openclaw` | OpenClaw 数据目录 |
| `MAIN_AGENT_ID` | gateway | `main` | 主 Agent ID |
| `RECOVERY_ENABLED` | gateway | `true` | 启用故障恢复 |
| `GATEWAY_ENABLED` | gateway | `true` | 启用 Gateway API |
| `GATEWAY_PORT` / `ROUTER_API_PORT` | gateway | `3100` | Gateway API 端口 |
| `VITE_API_BASE_URL` | dashboard | `''` | Dashboard API 基地址（空=走 `/api` 代理） |
| `VITE_WS_URL` | dashboard | `ws://<dashboard-host>` | Dashboard 消息 WS 基地址（空=同源） |
| `VITE_ROUTER_BASE` | dashboard | `/router-api` | Dashboard Router API 基路径 |
| `VITE_ROUTER_WS_URL` | dashboard | `ws://<dashboard-host>` | Dashboard Router WS 基地址（空=同源） |
| `VITE_DEV_API_TARGET` | dashboard dev | `http://localhost:3000` | Vite `/api*` 代理目标 |
| `VITE_DEV_WS_TARGET` | dashboard dev | `ws://localhost:3000` | Vite `/ws` 代理目标 |
| `VITE_DEV_ROUTER_API_TARGET` | dashboard dev | `http://localhost:3100` | Vite `/router-api` 代理目标 |
| `VITE_DEV_ROUTER_WS_TARGET` | dashboard dev | `ws://localhost:3100` | Vite `/router-ws` 代理目标 |

---

## 3. Kubernetes 部署

配置文件在 `infrastructure/k8s/`：

```
infrastructure/k8s/
├── api-deployment.yaml       # API Server (3 replicas)
├── gateway-deployment.yaml    # ClawTeam Gateway (1 replica per cluster)
├── dashboard-deployment.yaml # Dashboard (CDN + nginx)
├── postgres-statefulset.yaml # 或使用托管数据库
└── redis-statefulset.yaml    # 或使用托管 Redis
```

**注意事项：**
- Gateway 应为单实例 (不支持多 gateway 并行)
- API Server 可水平扩展 (Redis 做 Pub/Sub 同步)
- Dashboard 是纯静态文件，可部署到 CDN

---

## 4. 数据库管理

```bash
# 创建迁移
npm run migrate:create -- <migration_name>

# 执行迁移
npm run migrate:up

# 回滚
npm run migrate:down

# 重置数据库
./scripts/reset-database.sh
```

**备份：**
```bash
docker exec clawteam-postgres pg_dump -U clawteam clawteam > backup.sql
```

---

## 5. 安全注意事项

- 用户 API Key 在注册时分配，SHA-256 哈希存储；Bot 注册不再生成新 Key
- Dashboard admin 端点 (`/api/v1/tasks/all/*`) 无鉴权，仅限内网
- Redis 和 PostgreSQL 应配置密码
- 生产环境使用 HTTPS (nginx TLS termination)
- Gateway 本地 API 仅监听 127.0.0.1

---

## 6. Skill 配置 (Core + Files)

OpenClaw 不再使用 MCP Server。Agent 能力通过 `SKILL.md` 注入系统提示词，Agent 直接用 curl 调用 Gateway 代理端点 (`:3100`)。

### 工作原理

1. Skill 文档在 Agent 启动时注入 system prompt，描述所有可用的 Gateway API 操作
2. Agent 通过 curl 直接调用 `http://localhost:3100/gateway/*` 端点
3. Gateway 处理认证和路由，Agent 无需 API Key

### OpenClaw 配置

推荐拆分两个 skill：

- Core：`packages/openclaw-skill/SKILL.md`（委托、消息、状态、审批）
- Files：`packages/openclaw-files-skill/SKILL.md`（任务文件、artifact、publish）

OpenClaw 可自动加载已安装 skill。

在 `~/.openclaw/openclaw.json` 中启用：

```json
{
  "skills": {
    "entries": {
      "clawteam": {
        "enabled": true
      },
      "clawteam-files": {
        "enabled": true
      }
    }
  }
}
```

无需配置 `env` — Gateway 在本地 `:3100` 运行，skill 文档中已使用该默认地址。

### 验证 Skill 是否生效

启动 Gateway 后，Agent 应能直接执行：

```bash
# 列出所有 Bot
curl -s http://localhost:3100/gateway/bots

# 注册为 Bot
curl -s -X POST http://localhost:3100/gateway/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"MyBot","capabilities":[{"name":"test","description":"Test capability"}]}'
```

### 环境变量说明

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `CLAWTEAM_API_URL` | 否 | `http://localhost:3000` | API Server 地址 (Gateway 使用) |
| `CLAWTEAM_API_KEY` | 是 | — | 用户 API Key (config.yaml 配置) |

注意：Agent 本身不需要任何环境变量。所有配置由 Gateway 服务管理，Agent 只需通过 curl 调用 Gateway 端点。
