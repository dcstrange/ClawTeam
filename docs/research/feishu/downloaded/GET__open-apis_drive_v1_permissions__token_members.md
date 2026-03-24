# 获取云文档协作者

获取指定云文档的协作者，支持查询人、群、组织架构、用户组、知识库成员五种类型的协作者。

## 前提条件

调用该接口前，你需确保当前应用或用户具有查看协作者的权限。了解更多，参考[如何为应用或用户开通文档权限](https://open.feishu.cn/document/ukTMukTMukTM/uczNzUjL3czM14yN3MTN#16c6475a)。

## 请求

基本 | &nbsp;
---|---
HTTP URL | https://open.feishu.cn/open-apis/drive/v1/permissions/:token/members
HTTP Method | GET
接口频率限制 | [1000 次/分钟、50 次/秒](https://open.feishu.cn/document/ukTMukTMukTM/uUzN04SN3QjL1cDN)
支持的应用类型 | Custom App、Store App
权限要求<br>**调用该 API 所需的权限。开启其中任意一项权限即可调用**<br>开启任一权限即可 | 查看、评论、编辑和管理多维表格(bitable:app)<br>查看、编辑和管理知识库(wiki:wiki)<br>查看、评论、编辑和管理文档(docs:doc)<br>查看云文档的协作者列表(docs:permission.member:retrieve)<br>查看、评论、编辑和管理云空间中所有文件(drive:drive)<br>查看、评论、编辑和管理电子表格(sheets:spreadsheet)<br>查看、评论、编辑和管理多维表格（套件内）(bitable:bitable)
字段权限要求 | **注意事项**：该接口返回体中存在下列敏感字段，仅当开启对应的权限后才会返回；如果无需获取这些字段，则不建议申请<br>获取用户基本信息(contact:user.base:readonly)<br>以应用身份访问通讯录(contact:contact:access_as_app)<br>读取通讯录(contact:contact:readonly)<br>以应用身份读取通讯录(contact:contact:readonly_as_app)

### 请求头

名称 | 类型 | 必填 | 描述
---|---|---|---
Authorization | string | 是 | `tenant_access_token`<br>或<br>`user_access_token`<br>**值格式**："Bearer `access_token`"<br>**示例值**："Bearer u-7f1bcd13fc57d46bac21793a18e560"<br>[了解更多：如何选择与获取 access token](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-choose-which-type-of-token-to-use)

### 路径参数

名称 | 类型 | 描述
---|---|---
token | string | 云文档的 token，需要与 type 参数指定的云文档类型相匹配。可参考[如何获取云文档资源相关 token](https://open.feishu.cn/document/ukTMukTMukTM/uczNzUjL3czM14yN3MTN#08bb5df6)。<br>**示例值**："doccnBKgoMyY5OMbUG6FioTXuBe"

### 查询参数

名称 | 类型 | 必填 | 描述
---|---|---|---
type | string | 是 | 云文档类型，需要与云文档的 token 相匹配。<br>**示例值**：docx<br>**可选值有**：<br>- doc：旧版文档。了解更多，参考[新旧版本文档说明](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/docs/upgraded-docs-access-guide/upgraded-docs-openapi-access-guide)。<br>- sheet：电子表格<br>- file：云空间文件<br>- wiki：知识库节点<br>- bitable：多维表格<br>- docx：新版文档<br>- mindnote：思维笔记<br>- minutes：妙记<br>- slides：幻灯片
fields | string | 否 | 指定返回的协作者字段信息，如无指定则默认不返回。<br>**可选值有：** <br>- `name`：协作者名<br>- `type`：协作者类型<br>- `avatar`：头像<br>- `external_label`：外部标签<br>**注意**：<br>- 你可以使用特殊值`*`指定返回目前支持的所有字段<br>- 你可以使用`,`分隔若干个你想指定返回的字段，如：`name,avatar`<br>- 按需指定返回字段接口性能更好<br>**示例值**：*
perm_type | string | 否 | 协作者的权限角色类型。当云文档类型为 wiki 即知识库节点时，该参数有效。<br>**默认值**：container<br>**示例值**：container<br>**可选值有**：<br>- container：当前页面及子页面<br>- single_page：仅当前页面，当且仅当在知识库文档中该参数有效

## 响应

### 响应体

名称 | 类型 | 描述
---|---|---
code | int | 错误码，非 0 表示失败
msg | string | 错误描述
data | \- | \-
items | member\[\] | 返回的列表数据
member_type | string | 协作者 ID 类型，与协作者 ID 需要对应<br>**可选值有**：<br>- email：飞书邮箱<br>- openid：开放平台 ID<br>- unionid：开放平台 UnionID<br>- openchat：开放平台群组 ID<br>- opendepartmentid：开放平台部门 ID<br>- userid：用户自定义 ID<br>- groupid：自定义用户组 ID<br>- wikispaceid：知识空间 ID<br>- **注意**：仅知识库文档支持该参数，代表知识库文档里的「知识库成员」类型协作者的 ID
member_id | string | 协作者 ID，与协作者 ID 类型需要对应
perm | string | 协作者对应的权限角色<br>**可选值有**：<br>- view：可阅读角色<br>- edit：可编辑角色<br>- full_access：可管理角色
perm_type | string | 协作者的权限角色类型<br>**可选值有**：<br>- container：当前页面及子页面<br>- single_page：仅当前页面，当且仅当在知识库文档中该参数有效
type | string | 协作者的类型<br>**可选值有**：<br>- user：用户<br>- chat：群组<br>- department：组织架构<br>- group：用户组<br>- wiki_space_member：知识库成员<br>- **注意**：在知识库启用了成员分组功能后不支持该参数<br>- wiki_space_viewer：知识库可阅读成员<br>- **注意**：仅在知识库启用了成员分组功能后才支持该参数<br>- wiki_space_editor：知识库可编辑成员<br>- **注意**：仅在知识库启用了成员分组功能后才支持该参数
name | string | 协作者的名字<br>**字段权限要求（满足任一）**：<br>获取用户基本信息(contact:user.base:readonly)<br>以应用身份访问通讯录(contact:contact:access_as_app)<br>读取通讯录(contact:contact:readonly)<br>以应用身份读取通讯录(contact:contact:readonly_as_app)
avatar | string | 协作者的头像<br>**字段权限要求（满足任一）**：<br>获取用户基本信息(contact:user.base:readonly)<br>以应用身份访问通讯录(contact:contact:access_as_app)<br>读取通讯录(contact:contact:readonly)<br>以应用身份读取通讯录(contact:contact:readonly_as_app)
external_label | boolean | 协作者的外部标签

### 响应体示例
```json
{
    "code": 0,
    "msg": "Success",
    "data": {
        "items": [
            {
                "member_type": "openid",
                "member_id": "ou_7dab8a3d3cdcc9da365777c7ad535d62",
                "perm": "view",
                "perm_type": "container",
                "type": "user",
                "name": "zhangsan",
                "avatar": "https://s3-imfile.feishucdn.com/static-resource/v1/v3_0061_b576862d-92e0-4abc-bbb5-6f78f927a61g~?image_size=72x72&cut_type=default-face&quality=&format=jpeg&sticker_format=.webp",
                "external_label": true
            }
        ]
    }
}
```

### 错误码

HTTP状态码 | 错误码 | 描述 | 排查建议
---|---|---|---
400 | 1063001 | Invalid parameter | 参数异常，可能是如下原因：<br>- 参数类型不匹配，如：<br>- 云文档的 token 和 type 不匹配<br>- 云文档不存在<br>- 添加协作者的 member_id 和 member_type 不匹配<br>- 添加的协作者不存在<br>- 不支持的参数调用，如：<br>- 使用 `tenant_access_token` 添加部门协作者<br>- 给妙记添加可管理角色
403 | 1063002 | Permission denied | 调用身份对应的用户或应用不是云文档的[协作者](https://www.feishu.cn/hc/zh-CN/articles/064037224266-%E4%BA%91%E6%96%87%E6%A1%A3%E5%92%8C%E6%96%87%E4%BB%B6%E5%A4%B9%E5%8D%8F%E4%BD%9C%E8%80%85%E4%BB%8B%E7%BB%8D)或对云文档的权限（如编辑、管理权限）不足。请参考以下方式解决：<br>- 对于转移所有者接口，你需确保调用身份为云文档的所有者<br>- 对于协作者、权限设置相关接口，你需先参考[谁可以查看、添加、移除协作者](https://www.feishu.cn/hc/zh-CN/articles/360049067527-%E8%AE%BE%E7%BD%AE%E4%BA%91%E6%96%87%E6%A1%A3%E5%88%86%E4%BA%AB-%E5%A4%8D%E5%88%B6-%E4%B8%8B%E8%BD%BD-%E8%AF%84%E8%AE%BA%E7%AD%89%E6%9D%83%E9%99%90#tabs0|lineguid-Bp0bI)了解当前云文档的权限设置，再为调用身份开通所需权限：<br>- 如果你使用的是 `tenant_access_token`，你需通过云文档网页页面右上方 **「...」** -> **「...更多」** ->**「添加文档应用」** 入口为应用添加权限。<br>![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/22c027f63c540592d3ca8f41d48bb107_CSas7OYJBR.png?height=1994&maxWidth=550&width=3278)<br>**注意**：<br>- 在 **添加文档应用** 前，你需确保目标应用至少开通了一个云文档或多维表格的 [API 权限](https://open.feishu.cn/document/ukTMukTMukTM/uYTM5UjL2ETO14iNxkTN/scope-list)。否则你将无法在文档应用窗口搜索到目标应用。<br>- 如果多维表格开启了高级权限，你需为应用添加多维表格的 **可管理** 权限，否则仍无法操作多维表格。<br>![image.png](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/9f3353931fafeea16a39f0eb887db175_0tjzC9P3zU.png?maxWidth=550)<br>- 如果你使用的是 `user_access_token`，你需通过云文档网页页面右上方 **分享** 入口为当前用户添加权限。<br>![image.png](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/3e052d3bac56f9441296ae22e2969d63_a2DEYrJup8.png?height=278&maxWidth=550&width=1383)<br>了解具体操作步骤或其它添加权限方式，参考[云文档常见问题 3](https://open.feishu.cn/document/ukTMukTMukTM/uczNzUjL3czM14yN3MTN#16c6475a)。
400 | 1063003 | Invalid operation | 非法操作。该错误码表示基本参数校验没有问题，但操作不被允许，可能是如下原因：<br>- 云文档的协作者数量到达上限，请减少协作者数量<br>- 因企业设置的管控策略而无法修改权限<br>- 受可见性限制无法修改权限。例如：<br>- **添加用户协作者**：需要调用身份与被授权对象为联系人或同组织内可搜索，且互相未屏蔽。<br>- **添加群协作者**：需要调用身份在群内。要使用 `tenant_access_token` 身份添加群协作者，则需要将该应用作为机器人添加至群组中，使应用对群可见。详细步骤参考[如何为应用开通云文档相关资源的权限](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-add-permissions-to-app)。<br>- **添加部门协作者**：需要调用身份对部门可见。由于应用对企业内的组织架构都不可见，所以暂不支持通过 `tenant_access_token`  添加部门协作者。<br>- 给文档所有者添加权限（不允许对文档所有者操作权限）<br>- 协作者本身已有的权限大于请求参数内设置的权限
403 | 1063004 | User has no share permission | 用户无分享权限，请确认调用身份对该文档是否有分享权限。
404 | 1063005 | Resource is deleted | 资源已删除，请确认云文档是否还存在。
429 | 1063006 | Too many request | 请求发生限频，请降低请求频率并稍后重试。
500 | 1066001 | Internal Error | 服务内部错误，包括服务端内部超时、错误码没处理等，请联系[技术支持](https://applink.feishu.cn/TLJpeNdW)排查。
500 | 1066002 | Concurrency error, please retry | 服务内部错误，请重试或联系[技术支持](https://applink.feishu.cn/TLJpeNdW)排查。

