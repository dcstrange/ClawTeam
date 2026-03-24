# 创建知识空间

此接口用于创建知识空间

**注意事项**：此接口不支持tenant access token（应用身份访问）

## 请求

基本 | &nbsp;
---|---
HTTP URL | https://open.feishu.cn/open-apis/wiki/v2/spaces
HTTP Method | POST
接口频率限制 | [10 次/分钟](https://open.feishu.cn/document/ukTMukTMukTM/uUzN04SN3QjL1cDN)
支持的应用类型 | Custom App、Store App
权限要求<br>**调用该 API 所需的权限。开启其中任意一项权限即可调用**<br>开启任一权限即可 | 创建、更新知识空间(wiki:space:write_only)<br>查看、编辑和管理知识库(wiki:wiki)

### 请求头

名称 | 类型 | 必填 | 描述
---|---|---|---
Authorization | string | 是 | `user_access_token`<br>**值格式**："Bearer `access_token`"<br>**示例值**："Bearer u-7f1bcd13fc57d46bac21793a18e560"<br>[了解更多：如何选择与获取 access token](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-choose-which-type-of-token-to-use)
Content-Type | string | 是 | **固定值**："application/json; charset=utf-8"

### 请求体

名称 | 类型 | 必填 | 描述
---|---|---|---
name | string | 否 | 知识空间名称<br>**示例值**："知识空间"
description | string | 否 | 知识空间描述<br>**示例值**："知识空间描述"
open_sharing | string | 否 | 表示知识空间的分享状态<br>**示例值**："open"<br>**可选值有**：<br>- open：打开<br>- closed：关闭<br>**数据校验规则**：<br>- 长度范围：`0` ～ `99` 字符

### 请求体示例
```json
{
    "name": "知识空间",
    "description": "知识空间描述"
}
```

## 响应

### 响应体

名称 | 类型 | 描述
---|---|---
code | int | 错误码，非 0 表示失败
msg | string | 错误描述
data | \- | \-
space | space | 知识空间
name | string | 知识空间名称
description | string | 知识空间描述
space_id | string | 知识空间id
space_type | string | 表示知识空间类型（团队空间 或 个人空间）<br>**可选值有**：<br>- team：团队空间<br>- person：个人空间
visibility | string | 表示知识空间可见性（公开空间 或 私有空间）<br>**可选值有**：<br>- public：公开空间<br>- private：私有空间
open_sharing | string | 表示知识空间的分享状态<br>**可选值有**：<br>- open：打开<br>- closed：关闭

### 响应体示例
```json
{
    "code": 0,
    "msg": "success",
    "data": {
        "space": {
            "name": "知识空间",
            "description": "知识空间描述",
            "space_id": "1565676577122621"
        }
    }
}
```

### 错误码

HTTP状态码 | 错误码 | 描述 | 排查建议
---|---|---|---
400 | 131001 | rpc fail | 服务报错，请稍后重试，或者拿响应体的header头里的x-tt-logid咨询[oncall](https://applink.feishu.cn/client/helpdesk/open?id=6626260912531570952)定位。
400 | 131002 | param err | 通常为传参有误，例如数据类型不匹配。请查看**具体接口报错信息**，报错不明确时请咨询[oncall](https://applink.feishu.cn/client/helpdesk/open?id=6626260912531570952)。
400 | 131003 | out of limit | 超出操作限制，例如节点数量限制。请参阅下表。<br>- 原/目标知识空间总节点数不超过40万。<br>- 原/目标知识空间目录树不超过50层。<br>- 目的父节点下单层节点数不超过2000。<br>- 单次移动节点数（带子节点）不超过2000。
400 | 131004 | invalid user | 非法用户。请咨询[oncall](https://applink.feishu.cn/client/helpdesk/open?id=6626260912531570952)。
400 | 131005 | not found | 未找到相关数据，例如id不存在。相关报错信息参考：<br>- member not found：用户不是知识空间成员（管理员），无法删除。<br>- identity not found: userid不存在，无法添加/删除成员。<br>- space not found：知识空间不存在<br>- node not found：节点不存在<br>- document not found：文档不存在<br>报错不明确时请咨询[oncall](https://applink.feishu.cn/client/helpdesk/open?id=6626260912531570952)。
400 | 131006 | permission denied | 权限拒绝，相关报错信息参考：<br>- wiki space permission denied：知识库权限鉴权不通过，需要成为知识空间管理员（成员）。<br>- node permission denied：文档节点权限鉴权不通过，读操作需要具备节点阅读权限，写操作（创建、移动等）则需要具备节点容器编辑权限。<br>- no source parent node permission：需要具备原父节点的容器编辑权限。<br>- no destination parent node permission：需要具备目标父节点的容器编辑权限，若移动到知识空间下，则需要成为知识空间管理员（成员）。<br>**注意**：应用访问或操作文档时，除了申请 API 权限，还需授权具体文档资源的阅读、编辑或管理权限。<br>请参考以下步骤操作： <br>1. **当遇到资源权限不足的情况**：参阅[如何给应用授权访问知识库文档资源](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/wiki-v2/wiki-qa#a40ad4ca)。<br>2. **也可直接将应用添加为知识库管理员（成员）**：参阅[如何将应用添加为知识库管理员（成员）](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/wiki-v2/wiki-qa#b5da330b)。<br>3. **若无法解决或报错信息不明确时**：请咨询[技术支持](https://applink.feishu.cn/client/helpdesk/open?id=6626260912531570952)。
400 | 131007 | internal err | 服务内部错误，请勿重试，拿返回值的header头里的x-tt-logid咨询[oncall](https://applink.feishu.cn/client/helpdesk/open?id=6626260912531570952)定位。

