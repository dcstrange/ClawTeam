# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 2026-03-19

### Changed

#### Curl SessionKey 自动注入 — 替代 spawn meta block 方案

Session-task 绑定不再依赖 LLM 在 spawn 时传递 `[CLAWTEAM_META]` 块或 `_clawteam_*` 参数。改为 plugin 拦截 sub-session 中的 curl 命令，自动注入 `sessionKey` 到 JSON body，由 gateway 自动建立绑定。

**Plugin (`packages/openclaw-plugin/index.ts`)**
- 新增 `injectSessionKeyIntoCurl()` — 拦截 curl 命令，自动注入 sessionKey 到 gateway 请求的 JSON body
- 新增 `parseTaskMarkers()` / `stripMarkerLines()` — 用纯文本 `Role:/Task ID:/From Bot:` 标记替代 `[CLAWTEAM_META]` block 解析
- `before_tool_call` 新增 curl 拦截路径（Path 2），通过 `ctx.sessionKey` 注入
- 移除 `parseClawTeamMeta()` / `stripMetaBlock()` / `META_RE` / `ClawTeamMeta` interface
- 移除 `TASK_ID_KEY` / `ROLE_KEY` / `FROM_BOT_ID_KEY` 常量及 `_clawteam_*` 参数注入
- 移除整个 `after_tool_call` handler（session tracking 由 curl 注入 + gateway auto-track 完成）

**Gateway (`packages/clawteam-gateway/src/gateway/gateway-proxy.ts`)**
- 新增 `extractAndTrackSession()` — 从请求 body 提取 sessionKey，自动 track 并持久化到 API server，返回去掉 sessionKey 的 clean body
- 应用到全部 9 个 POST `/gateway/tasks/:taskId/*` 端点（delegate, accept, complete, submit-result, approve, reject, need-human-input, cancel, resume）
- 应用到 POST `/gateway/messages/send`（当 body 含 taskId 时）

**Router (`packages/clawteam-gateway/src/routing/router.ts`)**
- 移除 `buildClawTeamMetaBlock()` 函数
- `buildNewTaskMessage()` / `buildFallbackMessage()` 改用 `Role: executor\nTask ID: ...\nFrom Bot: ...` 纯文本标记
- `buildDelegateIntentMessage()` 改用 `Role: sender\nTask ID: ...` 纯文本标记

## [1.0.0] - 2026-03-03

### Added

#### Core Platform
- **Capability Registry**: Bot discovery and capability-based search with semantic matching
- **Task Coordinator**: Complete task lifecycle management (delegate, accept, complete, cancel)
- **Message Bus**: Real-time WebSocket communication with Redis Pub/Sub backend
- **Primitive System**: L0-L3 operations for task and bot management
- **API Server**: RESTful API with 323 tests and 85% code coverage

#### Routing Layer
- **ClawTeam Gateway**: Local gateway for task routing and session management
- **Task Router**: Intelligent routing based on bot capabilities and session availability
- **Session Tracker**: Automatic OpenClaw session tracking and management
- **Heartbeat Monitor**: Health checking for active sessions
- **Recovery Manager**: Automatic recovery of stale and failed tasks

#### User Interfaces
- **Web Dashboard**: Modern React-based UI with real-time updates
  - Bot management and discovery
  - Task monitoring and delegation
  - Message inbox
  - Session status tracking
  - Team workspace visualization
- **Terminal TUI**: Ink-based terminal interface for developers
  - Bot list and detail views
  - Task management
  - Message viewing
  - Router status monitoring

#### Integration
- **OpenClaw Plugin**: Automatic session tracking for OpenClaw CLI
- **OpenClaw Skill**: Task delegation skill for OpenClaw agents
- **TypeScript SDK**: Client library for building custom bots
- **REST API**: Complete API for external integrations

#### Deployment
- **Docker Compose**: One-command local deployment
- **Kubernetes**: Production-ready K8s manifests
- **VM Deployment**: Scripts for VM-based deployment
- **Offline Bundle**: Air-gapped deployment support

#### Documentation
- Complete architecture documentation
- API reference (REST + WebSocket)
- Task operation guides
- Deployment guides
- Session management guide
- Recovery mechanism documentation

### Features

#### Task Management
- Task delegation with capability matching
- Sub-task creation and chaining
- Task cancellation and reset
- Automatic timeout detection
- Human input requests (NEED_HUMAN_INPUT status)
- Task nudging for reminders

#### Bot Management
- Bot registration with capabilities
- Capability search (semantic + keyword)
- Bot avatars (emoji-based)
- Heartbeat tracking
- Online/offline status

#### Session Management
- Automatic session creation and tracking
- Session recovery after crashes
- Session-based task routing
- Multi-session support per bot

#### Messaging
- Real-time WebSocket messaging
- Message acknowledgment tracking
- Offline message queuing
- Message retry with exponential backoff
- Broadcast and direct messaging

#### Security
- User API key authentication
- JWT-based session management
- API key hashing with salt
- CORS configuration
- Rate limiting (planned)

### Testing
- 323 unit tests with 85% coverage
- Integration tests for multi-bot scenarios
- End-to-end tests for task workflows
- Performance tests with k6

### Infrastructure
- PostgreSQL 16 for data persistence
- Redis 7 for caching and pub/sub
- Docker containerization
- Kubernetes support
- Health checks for all services

---

## [Unreleased]

### Planned Features
- Multi-tenancy support
- Advanced workflow engine
- Plugin system for custom capabilities
- Metrics and observability dashboard
- GraphQL API
- Mobile app (React Native)
- Rate limiting and throttling
- Advanced search with filters
- Task templates
- Bot marketplace

---

## Version History

- **1.0.0** (2026-03-03) - Initial open source release

---

## Migration Guides

### Upgrading to 1.0.0

This is the initial release. No migration needed.

---

## Breaking Changes

None (initial release).

---

## Deprecations

None (initial release).

---

## Security Updates

See [SECURITY.md](SECURITY.md) for security policy and reporting vulnerabilities.

---

**Note**: This changelog follows [Keep a Changelog](https://keepachangelog.com/) format. Each version includes:
- **Added**: New features
- **Changed**: Changes to existing functionality
- **Deprecated**: Soon-to-be removed features
- **Removed**: Removed features
- **Fixed**: Bug fixes
- **Security**: Security fixes
