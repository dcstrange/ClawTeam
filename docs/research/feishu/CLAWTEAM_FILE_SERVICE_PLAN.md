# ClawTeam 文件管理服务（对标飞书）可行性调研

更新时间：2026-03-23  
调研范围：飞书开放平台云文档/云空间相关 API（auth + drive + wiki + docx + permission + search）

## 1) 结论（先说人话）

可行，而且建议分两期做：

- 第一期（4-6 周）：先做“飞书模式的最小闭环”
  - 文件夹/文件上传下载/移动/删除
  - Docx 文档创建 + 纯文本读取
  - 基础协作者权限（读/写/管理）
  - Agent 可调用的统一文件工具
- 第二期（6-10 周）：再做“文档块级编辑 + 知识空间（Wiki）+ 检索”
  - 块级 API（create block / patch block）
  - Wiki 空间和节点树
  - 语义检索与权限联动

不建议一次性全量照抄飞书 API 面，复杂度和权限边界会显著拖慢交付。

## 2) 我们已下载的官方资料

已落盘目录：

- `docs/research/feishu/raw/server_side_api_list.json`（飞书官方 API 目录，含 `fullPath`）
- `docs/research/feishu/curated_endpoints.tsv`（本次筛选的 28 个关键接口）
- `docs/research/feishu/downloaded/*.md`（关键接口文档正文）

覆盖模块：

- Auth：`tenant_access_token`
- Drive：文件清单、创建文件夹、上传/下载、复制/移动/删除
- Permission：协作者增删改查、公开权限配置
- Docx：创建文档、获取内容、块级创建与更新
- Wiki：空间、节点创建/移动/查询
- Search：云文档搜索

## 3) 对标飞书后，ClawTeam 建议的服务拆分

### 3.1 控制面与数据面分离

- `file-control-plane`（元数据与权限）
  - 文件、文件夹、文档、wiki 节点元数据
  - ACL、共享规则、审计日志
  - 外部对象映射（ClawTeam token ↔ 存储对象键）
- `file-data-plane`（二进制与内容处理）
  - 上传/下载、分片、校验、病毒扫描
  - 文件版本
  - 大文件异步任务
- `docx-service`（结构化文档）
  - 文档树、block 模型、revision、幂等更新
- `search-service`
  - 文档元数据索引 + 内容索引
  - ACL 过滤后返回
- `gateway-plugin-tools`
  - 给 bot 暴露统一工具（`files.list`、`files.upload`、`docs.create` 等）

### 3.2 强制约束（建议写进协作原则）

- 所有读写都必须带 `actor`（human/bot/app）和 `workspace_id`
- 所有搜索结果都要经 ACL 过滤，不能先查后过滤给客户端
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
- `POST /open-apis/wiki/v2/spaces/:space_id/nodes`  
  -> `POST /api/wiki/spaces/:spaceId/nodes`

## 5) 核心数据模型（建议最小版）

- `file_nodes`
  - `id`, `workspace_id`, `parent_id`, `kind(file|folder|doc|wiki_node)`, `name`
  - `owner_actor_id`, `created_at`, `updated_at`, `deleted_at`
- `file_blobs`
  - `file_id`, `storage_key`, `size`, `checksum`, `mime_type`, `version`
- `doc_blocks`
  - `doc_id`, `block_id`, `parent_block_id`, `block_type`, `payload_json`, `revision`
- `acl_entries`
  - `resource_id`, `subject_type(user|bot|group|role)`, `subject_id`, `perm(view|edit|manage)`
- `resource_events`
  - 审计与可追溯事件流

## 6) 风险与规避

- 风险 1：权限模型太晚定，后期会反复重构
  - 规避：第一周内冻结 ACL 模型与继承规则
- 风险 2：块级编辑 API 复杂，测试爆炸
  - 规避：一期只做“纯文本 + 基础块”，高级块延后
- 风险 3：搜索泄漏权限
  - 规避：搜索服务必须内建 ACL 过滤，不接受客户端二次过滤
- 风险 4：大文件上传不稳定
  - 规避：先支持 `upload_all` + 20MB 上限，再加分片

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

- `wiki spaces/nodes` 最小能力
- 搜索（标题 + 简单正文）
- 端到端回归测试

### 里程碑 D（二期）

- doc block 深度编辑
- 版本回滚与高级协作能力
- 大规模性能优化

## 8) 需要你拍板的问卷（请按 1A 2B 这种格式回复）

1. 兼容策略  
A. 原生 API 为主 + 提供 feishu-like 适配层（推荐）  
B. 完全仿飞书路径/参数  
C. 只做原生 API

2. 首期文档能力范围  
A. 仅“创建文档 + 纯文本读写”（推荐）  
B. 直接上块级编辑  
C. 只做文件，不做 docx

3. 搜索能力首期范围  
A. 标题 + 元数据检索（推荐）  
B. 全文检索（含分词与高亮）  
C. 暂不做搜索

4. 上传策略  
A. 先 `upload_all`（20MB）再补分片（推荐）  
B. 首期就做分片上传  
C. 只支持小文件（<5MB）

5. 权限主体范围  
A. user + bot + group（推荐）  
B. 仅 user + bot  
C. user/bot/group/department 全支持

6. 继承模型  
A. 文件夹 ACL 默认向子节点继承，可打断（推荐）  
B. 不继承，逐条授权  
C. 只允许 owner 管理，不开放协作者

7. Bot 访问原则  
A. 严格“本 bot 代理”原则（推荐）  
B. 允许跨 bot 直接访问（同 workspace）  
C. 混合策略（高权限场景可跨 bot）

8. 部署形态  
A. 先做单租户（ClawTeam workspace 级）再演进多租户（推荐）  
B. 直接多租户  
C. 先本地模式（无租户）

9. 存储选型  
A. S3 兼容对象存储 + Postgres 元数据（推荐）  
B. 本地文件系统 + Postgres  
C. 全部存 DB（含二进制）

10. 交付优先级  
A. 先 API 与 bot 工具，再补 dashboard（推荐）  
B. 先 dashboard 再 API  
C. 并行推进

