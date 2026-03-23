# Feishu OpenAPI 调研包（2026-03-23）

本目录用于支持 ClawTeam 自研“飞书风格文件管理服务”的设计与评审。

## 目录说明

- `CLAWTEAM_FILE_SERVICE_PLAN.md`：可行性结论、架构方案与问卷
- `curated_endpoints.tsv`：精选接口清单（28 个）
- `downloaded/`：已下载的官方接口文档（Markdown）
- `raw/server_side_api_list.json`：飞书官方 API 目录接口原始返回

## 主要官方来源

- API 目录接口：`https://open.feishu.cn/api/tools/server-side-api/list`
- 自建应用 tenant_access_token：`https://open.feishu.cn/document/ukTMukTMukTM/ukDNz4SO0MjL5QzM/auth-v3/auth/tenant_access_token_internal`
- 云空间文件清单：`https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file/list`
- 云空间文件上传：`https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file/upload_all`
- 云空间权限设置（v2 public）：`https://open.feishu.cn/document/ukTMukTMukTM/uIzNzUjLyczM14iM3MTN/drive-v2/permission-public/get`
- Docx 创建文档：`https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document/create`
- Wiki 节点创建：`https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/wiki-v2/space-node/create`

