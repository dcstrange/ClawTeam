# ClawTeam 文件管理服务（对标飞书）可行性调研

更新时间：2026-03-23  
调研范围：飞书开放平台云文档/云空间相关 API（auth + drive + wiki + docx + permission + search）

## 1) 结论（先说人话）

可行。按你的决策，当前阶段采用“精简协作版”，不做复杂文档能力。

- 当前范围（唯一交付范围）：
  - 文件夹/文件上传下载/移动/删除
  - 文档创建 + 纯文本读取（不做块级编辑）
  - 基础协作者权限（读/写/管理）
  - Agent 可调用的统一文件工具

明确不做（本阶段 Out of Scope）：

- 文档块级编辑（create/patch block）
- 知识空间（Wiki）能力
- 文档检索能力（标题检索、全文检索均不做）

仍不建议 1:1 全量照抄飞书 API 面，采用“语义兼容 + 原生 API”最稳妥。

## 1.1) 决策锁定（你已确认）

你已确认问卷全部选择 A，固化如下：

1. 兼容策略：A（原生 API + feishu-like 适配层）
2. 首期文档能力：A（仅创建文档 + 纯文本读写）
3. 搜索能力：问卷原始选择 A（标题 + 元数据检索）  
   说明：根据你新增要求“尽量精简”，已覆盖该项，当前阶段将搜索整体下线，不纳入首期。
4. 上传策略：A（先 `upload_all` 20MB，再补分片）
5. 权限主体：A（user + bot + group）
6. 继承模型：A（文件夹 ACL 继承，可打断）
7. Bot 访问原则：A（严格本 bot 代理）
8. 部署形态：A（先单租户 workspace 级）
9. 存储选型：A（S3 兼容对象存储 + Postgres 元数据）
10. 交付优先级：A（先 API 与 bot 工具，再补 dashboard）

## 2) 我们已下载的官方资料

已落盘目录：

- `docs/research/feishu/raw/server_side_api_list.json`（飞书官方 API 目录，含 `fullPath`）
- `docs/research/feishu/curated_endpoints.tsv`（本次筛选的 28 个关键接口）
- `docs/research/feishu/downloaded/*.md`（关键接口文档正文）

覆盖模块：

- Auth：`tenant_access_token`
- Drive：文件清单、创建文件夹、上传/下载、复制/移动/删除
- Permission：协作者增删改查、公开权限配置
- Docx：创建文档、获取内容（本阶段仅用纯文本读取相关能力）
- Wiki：仅作为调研样本（本阶段不实现）
- Search：仅作为调研样本（本阶段不实现）

## 3) 对标飞书后，ClawTeam 建议的服务拆分

### 3.1 控制面与数据面分离

- `file-control-plane`（元数据与权限）
  - 文件、文件夹、文档元数据
  - ACL、共享规则、审计日志
  - 外部对象映射（ClawTeam token ↔ 存储对象键）
- `file-data-plane`（二进制与内容处理）
  - 上传/下载、分片、校验、病毒扫描
  - 文件版本
  - 大文件异步任务
- `doc-service`（精简文档能力）
  - 文档创建、文档元信息、纯文本读取
  - revision 与幂等更新基础能力
- `gateway-plugin-tools`
  - 给 bot 暴露统一工具（`files.list`、`files.upload`、`docs.create` 等）

### 3.2 强制约束（建议写进协作原则）

- 所有读写都必须带 `actor`（human/bot/app）和 `workspace_id`
- 对写操作强制幂等键（`client_token`）与重放保护
- 所有跨 bot 协作文件访问都走“本 bot 代理”原则（不允许旁路到他人 bot）

## 4) API 兼容策略（建议）

不做 1:1 克隆，做“语义兼容 + 渐进增强”：

- 对外推荐 ClawTeam 原生 API（更干净、符合你们多 bot 协作模型）
- 可选提供一层 `feishu-like` 适配路由（便于迁移和对照）

示例映射：

- `POST /open-apis/drive/v1/files/upload_all`  
  -> `POST /api/files/upload`
- `GET /open-apis/drive/v1/files`  
  -> `GET /api/files`
- `POST /open-apis/docx/v1/documents`  
  -> `POST /api/docs`
- `GET /open-apis/docx/v1/documents/:id/raw_content`  
  -> `GET /api/docs/:id/raw`

## 5) 核心数据模型（建议最小版）

- `file_nodes`
  - `id`, `workspace_id`, `parent_id`, `kind(file|folder|doc)`, `name`
  - `owner_actor_id`, `created_at`, `updated_at`, `deleted_at`
- `file_blobs`
  - `file_id`, `storage_key`, `size`, `checksum`, `mime_type`, `version`
- `doc_contents`
  - `doc_id`, `revision`, `raw_text_snapshot`, `updated_at`
- `acl_entries`
  - `resource_id`, `subject_type(user|bot|group|role)`, `subject_id`, `perm(view|edit|manage)`
- `resource_events`
  - 审计与可追溯事件流

## 6) 风险与规避

- 风险 1：权限模型太晚定，后期会反复重构
  - 规避：第一周内冻结 ACL 模型与继承规则
- 风险 2：上传链路在弱网场景不稳定
  - 规避：首期限制 20MB + 失败重试 + 校验和校验
- 风险 3：权限继承规则实现不一致导致越权
  - 规避：统一权限计算函数 + 覆盖继承/打断用例
- 风险 4：bot 侧工具调用行为不一致
  - 规避：定义统一 tool 契约 + 增加 gateway/plugin 端到端契约测试

## 7) 分期落地建议（可执行）

### 里程碑 A（第 1-2 周）

- DB schema + 文件树 + ACL
- `files.list/create_folder/upload/download`
- 审计日志

### 里程碑 B（第 3-4 周）

- `docs.create/get/raw_content`
- 权限成员管理（增删改查）
- gateway 工具封装给 bot

### 里程碑 C（第 5-6 周）

- `files.copy/move/delete` + 错误处理与幂等增强
- dashboard 最小可用页面（文件列表/上传/下载/分享）
- 端到端回归测试与发布准备

## 7.1) 最终交付清单（本阶段）

- 必做
  - 文件：列表、创建文件夹、上传、下载、复制、移动、删除
  - 文档：创建文档、读取纯文本内容
  - 权限：协作者增删改查 + 文档公开权限配置
  - 基础治理：ACL 继承、审计日志、幂等键、重试策略
  - 集成：gateway/plugin 工具 + dashboard 最小管理页
- 不做
  - 文档块级编辑
  - Wiki
  - 检索

## 8) 文件可见性模型（已确认）

采用混合模型，不走“全 Team 共享”或“全 Bot 私有”的极端：

### 8.1 三层命名空间

- `bot_private/<botId>/...`
  - 默认落点，工作中间态文件
  - 仅该 bot、其 owner、人类代理可见
- `task/<taskId>/...`
  - 任务协作主空间
  - 对该任务参与链路开放（delegator/executor/sub-delegate）
- `team_shared/...`
  - 团队发布空间
  - 仅放“已发布产物”，不放中间态

### 8.2 默认行为（强约束）

- 创建文件默认写入 `bot_private` 或 `task`，禁止默认写入 `team_shared`
- 任务完成后，发布动作由 delegator bot 执行
- 发布必须记录审计事件（谁在何时从哪里发布到哪里）

### 8.3 ACL 判定顺序

1. 显式拒绝（deny）  
2. 显式允许（allow）  
3. 父级继承 ACL  
4. 空 ACL 回退到 namespace 默认策略（`bot_private` / `task` / `team_shared`）

## 9) 典型访问判定表（可直接实现）

| 场景 | 目标空间 | 允许主体 | 结果 |
|---|---|---|---|
| bot 自己创建草稿 | `bot_private/<botId>` | 同 bot / owner | 允许 |
| 非 owner 的其他 bot 读取私有草稿 | `bot_private/<botId>` | 其他 bot | 拒绝 |
| 执行者读取当前任务素材 | `task/<taskId>` | 该任务参与者 | 允许 |
| 非任务参与者读取任务素材 | `task/<taskId>` | 非参与者 | 拒绝 |
| delegator 发布最终产物 | `team_shared` | delegator / owner | 允许 |
| 任意 bot 直接写团队空间 | `team_shared` | 非发布角色 | 拒绝 |
| 跨 bot 直接访问他人私有文件（无代理） | 任意 | 任意 | 拒绝 |

## 10) API 字段约定（建议首期落地）

所有文件写操作增加以下字段：

- `scope`: `bot_private | task | team_shared`
- `scopeRef`:  
  - `scope=bot_private` -> `botId`  
  - `scope=task` -> `taskId`  
  - `scope=team_shared` -> 可为空或 `workspaceId`
- `actor`: `human | bot | system`
- `actorId`
- `clientToken`（幂等）

发布接口建议：

- `POST /api/files/publish`
  - 入参：`sourceNodeId`, `targetPath`, `taskId`, `clientToken`
  - 校验：调用者必须是该任务 delegator 链路或 owner
  - 副作用：写入 `resource_events` 审计日志

## 11) 问卷结果与收口说明

已完成决策，不再需要问卷。若后续需要扩展范围，再新增二期决策单。
