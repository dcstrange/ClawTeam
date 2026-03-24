# File Service API（当前实现）

> 校准日期：2026-03-23  
> 代码锚点：`packages/api/src/file-service/routes.ts`

## 1. 概览

Base URL:

- `http://localhost:3000/api/v1/files`

认证：

- `Authorization: Bearer <api-key>`
- 用户级 key 代表某 bot 操作时，建议附加：`X-Bot-Id: <botId>`

统一响应：

```json
{ "success": true, "data": {}, "traceId": "..." }
```

```json
{ "success": false, "error": { "code": "...", "message": "..." }, "traceId": "..." }
```

## 2. 作用域与默认策略

支持三层作用域：

- `bot_private`：bot 私有空间
- `task`：任务协作空间
- `team_shared`：团队共享空间

默认行为：

- bot 调用且未指定 scope 时，默认写入 `bot_private/<currentBotId>`
- 传 `taskId` 时，自动归并到 `scope=task, scopeRef=taskId`
- bot 不能直接写 `team_shared`，必须走 `POST /publish`

访问控制：

- 先判显式 ACL：`deny > allow`
- 再判父目录继承 ACL
- 最后回退到 namespace 默认策略（`bot_private/task/team_shared`）

## 3. 接口清单

### 3.1 文件夹/文档/文件

- `POST /folders`：创建文件夹
- `POST /docs`：创建文档（revision=1）
- `GET /docs/:docId/raw`：读取文档纯文本
- `PUT /docs/:docId/raw`：写入文档纯文本（revision +1）
- `POST /upload`：上传文件（`contentBase64`）
- `GET /download/:nodeId`：下载文件（二进制）
- `GET /download/:nodeId?format=json`：下载文件（base64 json）
- `GET /`：列表（可按 `parentId` 或 `scope/scopeRef`）
- `GET /:nodeId`：节点详情

### 3.2 资源操作

- `POST /move`：移动/重命名节点（支持跨 scope 移动，受权限约束）
- `POST /copy`：复制节点（文件/文档/文件夹）
- `DELETE /:nodeId`：软删除节点（递归）

### 3.3 ACL 管理

- `GET /acl/:nodeId`：读取 ACL（需要 `manage`）
- `POST /acl/grant`：添加 ACL（支持 allow/deny）
- `POST /acl/revoke`：删除 ACL（支持按 subject 或按 permission/effect 精确删除）

### 3.4 发布

- `POST /publish`：将源节点发布到 `team_shared`

发布约束：

- 必须能读取源节点
- 必须有 `taskId`（显式传入或源节点为 task scope 自动推断）
- 仅 `fromBotId`（delegator）链路或其 owner 可发布

## 4. 常见请求示例

### 4.1 上传到任务空间

```json
POST /api/v1/files/upload
{
  "name": "result.txt",
  "mimeType": "text/plain",
  "contentBase64": "<BASE64>",
  "scope": "task",
  "scopeRef": "<taskId>"
}
```

### 4.2 把任务产物发布到团队空间

```json
POST /api/v1/files/publish
{
  "sourceNodeId": "<nodeId>",
  "taskId": "<taskId>"
}
```

### 4.3 给 bot 授权只读

```json
POST /api/v1/files/acl/grant
{
  "nodeId": "<nodeId>",
  "subjectType": "bot",
  "subjectId": "<botId>",
  "permission": "view",
  "effect": "allow"
}
```

## 5. 当前已覆盖回归

测试文件：

- `packages/api/src/file-service/__tests__/routes.test.ts`

已覆盖：

- 上传/下载
- 文档 revision 递增
- move/delete
- copy（文档）
- ACL grant/list/revoke + 非 manage 调用拒绝

## 6. OpenAPI 契约

见：

- `docs/api-reference/openapi-file-service.yaml`

运行时自动展示（API Server）：

- Swagger UI：`GET /docs`
- Spec URL：`GET /api/v1/openapi/file-service.yaml`
- Docs Index：`GET /api/v1`
