# ClawTeam Platform — EC2 API Server 部署教程

> 环境：Ubuntu on EC2 (t2.xlarge, 4 vCPU, 16GB RAM) / ap-northeast-1 (东京)
> 方案：EC2 部署 API + PostgreSQL + Redis，Dashboard 在本地运行连接远程 API

## 架构

```
  本地机器                              EC2 (云端)
  ┌──────────────────────┐             ┌──────────────────────┐
  │  Dashboard :5173     │── HTTP ────▶│  API Server :3000    │
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

---

## 第一步：SSH 登录 EC2

```bash
ssh -i your-key.pem ubuntu@<EC2_PUBLIC_IP>
```

---

## 第二步：确认 Docker 环境

```bash
docker --version
docker compose version

# 如果 docker compose 不可用
sudo apt-get update && sudo apt-get install -y docker-compose-plugin

# 确保当前用户在 docker 组
sudo usermod -aG docker $USER

# 安装 Git
sudo apt-get install -y git
```

---

## 第三步：拉取代码

```bash
cd ~
git clone <YOUR_REPO_URL> clawteam-platform
cd clawteam-platform
```

---

## 第四步：修改 docker-compose.yml

`docker-compose.yml` 里已经配好了数据库密码、Redis 连接等，只需改两处：

1. `CORS_ORIGIN` — 允许本地 Dashboard 跨域访问 API
2. `JWT_SECRET` — 生产环境建议换一个随机值

```bash
cd ~/clawteam-platform

# 1. 将 CORS_ORIGIN 改为允许所有来源（本地 Dashboard 会从不同 IP 访问）
sed -i 's|CORS_ORIGIN=http://localhost:8080|CORS_ORIGIN=*|' docker-compose.yml

# 2. 生成随机 JWT_SECRET 写入 .env（docker-compose.yml 会读取 ${JWT_SECRET}）
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env

# 验证改动
grep CORS_ORIGIN docker-compose.yml
cat .env
```

> 其他配置（DATABASE_URL、REDIS_URL 等）都是容器间内部通信，不需要改。

---

## 第五步：一键部署（推荐）

项目提供了一键部署脚本，自动完成：启动基础设施 → 等待 PostgreSQL 就绪 → 运行数据库迁移 → 构建并启动 API → 健康检查。

```bash
cd ~/clawteam-platform
bash scripts/deploy-ec2.sh
```

脚本会按顺序执行：
1. `git pull` 拉取最新代码
2. 启动 PostgreSQL + Redis
3. 等待 PostgreSQL 就绪（最多 30s）
4. 运行所有迁移（只执行 `-- Up` 部分，已存在的表/列会自动跳过）
5. 构建并启动 API 容器
6. 等待 API 健康检查通过

验证：

```bash
docker compose --profile production ps
# 期望：
# clawteam-postgres  running (healthy)
# clawteam-redis     running (healthy)
# clawteam-api       running (healthy)
```

---

## 手动部署（可选）

如果需要分步执行：

### 5a. 启动基础设施

```bash
cd ~/clawteam-platform
docker compose up -d postgres redis

# 等待 PostgreSQL 就绪
until docker exec clawteam-postgres pg_isready -U clawteam -d clawteam; do sleep 1; done
```

### 5b. 运行数据库迁移

迁移文件包含 `-- Up` 和 `-- Down` 两部分，只需执行 Up 部分：

```bash
for f in packages/api/migrations/*.sql; do
  echo "→ $(basename $f)"
  sed -n '/^-- Up$/,/^-- Down$/{ /^-- Up$/d; /^-- Down$/d; p }' "$f" | \
    docker exec -i clawteam-postgres psql -U clawteam -d clawteam 2>&1 | grep -v "already exists" || true
done

# 验证
docker exec clawteam-postgres \
  psql -U clawteam -d clawteam -c "\dt"
```

### 5c. 启动 API

```bash
docker compose --profile production up -d --build api
```

---

## 第七步：配置安全组

在  控制台确保 EC2 安全组开放：

| 端口 | 协议 | 来源 | 用途 |
|------|------|------|------|
| 22   | TCP  | 你的 IP | SSH |
| 3000 | TCP  | 0.0.0.0/0 | API Server |

> ⚠️ 5432 和 6379 不要对外开放，只在容器内部通信。

---

## 第八步：验证 API

```bash
curl http://<EC2_PUBLIC_IP>:3000/health
# 应返回：{"status":"ok"}
```

---

## 第九步：本地 Dashboard 连接远程 API

回到本地机器，修改 Dashboard 的 vite 开发代理指向 EC2：

编辑 `packages/dashboard/vite.config.ts`，将 proxy target 改为 EC2 地址：

```typescript
server: {
    port: 5173,
    proxy: {
      '/api/tasks': {
        target: 'http://<EC2_PUBLIC_IP>:3000',  // ← 改这里
        changeOrigin: true,
        rewrite: (path) => {
          if (path === '/api/tasks' || path === '/api/tasks/') return '/api/v1/tasks/all';
          return path.replace(/^\/api/, '/api/v1');
        },
      },
      '/api': {
        target: 'http://<EC2_PUBLIC_IP>:3000',  // ← 改这里
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/api/v1'),
      },
      '/ws': {
        target: 'ws://<EC2_PUBLIC_IP>:3000',    // ← 改这里
        ws: true,
      },
      // Gateway 保持本地
      '/router-api': {
        target: 'http://localhost:3100',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/router-api/, ''),
      },
      '/router-ws': {
        target: 'ws://localhost:3100',
        ws: true,
        rewrite: (path) => path.replace(/^\/router-ws/, '/ws'),
      },
    },
  },
```

然后启动本地 Dashboard：

```bash
cd packages/dashboard
npm run dev
# 访问 http://localhost:5173
```

---

## 日常运维

### 查看日志

```bash
# SSH 到 EC2 后
docker compose logs -f api
docker compose logs -f postgres
docker compose logs -f redis
```

### 重启 API

```bash
docker compose restart api
```

### 停止所有服务

```bash
docker compose --profile production down
```

---

## 更新部署

EC2 上执行一键脚本即可（自动 git pull + 迁移 + 构建 + 健康检查）：

```bash
cd ~/clawteam-platform
bash scripts/deploy-ec2.sh
```

---

## 数据备份

```bash
# 备份
docker exec clawteam-postgres \
  pg_dump -U clawteam clawteam > ~/backup_$(date +%Y%m%d_%H%M%S).sql

# 定时备份（crontab -e 添加）
0 3 * * * docker exec clawteam-postgres pg_dump -U clawteam clawteam > ~/backups/clawteam_$(date +\%Y\%m\%d).sql
```

---

## 清空环境 / 重置

当需要从零开始（清除所有数据、容器、镜像）时，SSH 到 EC2 执行：

### 完整重置（推荐）

```bash
cd ~/clawteam-platform

# 1. 停止所有容器并删除 volumes（数据库 + Redis 数据全部清除）
docker compose --profile production down -v

# 2. 删除构建缓存的镜像（可选，强制下次 --build 重新构建）
docker rmi clawteam-platform-api clawteam-platform-dashboard 2>/dev/null || true

# 3. 重新部署
bash scripts/deploy-ec2.sh
```

> `down -v` 会删除 `postgres_data` 和 `redis_data` 两个 volume，所有 bot、task、message 数据将被清除。迁移脚本会在重新部署时自动重建表结构。

### 仅清空数据（保留容器和镜像）

```bash
# 停掉 API，保留基础设施运行
docker compose --profile production stop api

# 清空数据库所有表数据（保留表结构）
docker exec clawteam-postgres psql -U clawteam -d clawteam -c "
DO \$\$ DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
  END LOOP;
END \$\$;"

# 清空 Redis
docker exec clawteam-redis redis-cli FLUSHALL

# 重启 API
docker compose --profile production start api
```

### 重建数据库结构（表结构变更后）

```bash
docker compose --profile production stop api

# 删掉数据库，重建
docker exec clawteam-postgres psql -U clawteam -c "DROP DATABASE clawteam"
docker exec clawteam-postgres psql -U clawteam -c "CREATE DATABASE clawteam"

# 重新跑迁移
for f in packages/api/migrations/*.sql; do
  echo "→ $(basename $f)"
  sed -n '/^-- Up$/,/^-- Down$/{ /^-- Up$/d; /^-- Down$/d; p }' "$f" | \
    docker exec -i clawteam-postgres psql -U clawteam -d clawteam 2>&1 | grep -v "already exists" || true
done

docker compose --profile production start api
```

---

## 故障排查

| 问题 | 排查 |
|------|------|
| 本地 Dashboard 连不上 API | 确认安全组开放 3000 端口；`curl http://<IP>:3000/health` 测试 |
| API 502/启动失败 | `docker compose logs api` 查看错误 |
| 数据库连接失败 | `docker exec clawteam-postgres pg_isready` |
| WebSocket 断连 | 确认安全组允许长连接；检查 API 日志 |

---

## 注意事项

1. **安全**：`.env` 中的 JWT_SECRET 已自动生成，如需修改数据库密码需同时改 `docker-compose.yml` 中 postgres 和 api 两处
2. **端口**：只对外暴露 22 和 3000，数据库端口不要开放
3. **HTTPS**：后续可在 EC2 前加 CloudFront 或 Nginx + Let's Encrypt
4. **ClawTeam Gateway**：继续在本地运行，通过本地 Dashboard 的 `/router-api` 代理访问
5. **OpenClaw 接入**：通过 SKILL.md 注入 curl 命令，调用本地 Gateway `/gateway/*` 端点与 EC2 API Server 交互。配置方式见 `-local-deployment.md`
