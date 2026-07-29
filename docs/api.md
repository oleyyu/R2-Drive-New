# 开发者 API

API 根路径与应用同源。浏览器使用会话 Cookie；自动化客户端使用：

```http
Authorization: Bearer r2d_...
```

错误统一返回：

```json
{
  "error": {
    "message": "可读错误信息",
    "code": "machine_readable_code"
  }
}
```

## Scope

| Scope | 允许操作 |
| --- | --- |
| `files:read` | 列出文件、下载私有文件 |
| `files:write` | 创建文件夹、重命名、移动、固定、回收站操作、Multipart 上传 |
| `shares:write` | 查看、创建和撤销公开分享 |

账号设置、API Token 管理和管理员路由只接受浏览器会话。

管理员可手动检查正式版：

```http
GET /api/admin/update
```

该接口只返回当前版本、GitHub 最新正式版和 Release 页面，不执行安装。更新需要本机 Wrangler，因此只能在回环地址的安装助手中由使用者明确确认，不能通过公开 Worker API 触发。

## 文件

```http
GET /api/files?parentId=<uuid>&scope=all&search=&sort=name&order=asc
POST /api/files
PATCH /api/files/:id
DELETE /api/files/:id
POST /api/files/:id/restore
GET /api/files/:id/download
```

`scope` 支持 `all`、`recent`、`image`、`document`、`video`、`audio`、`other`、`trash`、`pinned` 和 `folders`。分类、最近与搜索覆盖整个用户空间；普通目录列表才使用 `parentId`。

创建文件夹：

```json
{ "name": "文档", "parentId": null }
```

重命名、移动或固定：

```json
{ "name": "新名称", "parentId": "<目标文件夹 uuid 或 null>", "isPinned": true }
```

默认 `DELETE /api/files/:id` 把项目及其子树移入回收站。`DELETE /api/files/:id?permanent=true` 永久删除已在回收站中的项目；`DELETE /api/files?scope=trash` 清空回收站。

## Multipart 上传

### 创建任务

```http
POST /api/uploads
Content-Type: application/json

{
  "name": "archive.tar",
  "size": 128849018880,
  "contentType": "application/x-tar",
  "parentId": null,
  "partSizeHintBytes": 67108864
}
```

`partSizeHintBytes` 可选，服务端会在 R2 合法范围和 10,000 分片上限内调整。响应包含 `fileId`、`partSize`、`expectedParts` 和 `direct`。

### 上传分片

直传：

```http
POST /api/uploads/:fileId/parts/:partNumber/sign
PUT <response.url>
```

保存 PUT 响应的 `ETag`。代理模式：

```http
PUT /api/uploads/:fileId/parts/:partNumber
```

### 完成

```http
POST /api/uploads/:fileId/complete
Content-Type: application/json

{
  "parts": [
    { "partNumber": 1, "etag": "\"...\"" },
    { "partNumber": 2, "etag": "\"...\"" }
  ]
}
```

中止：

```http
POST /api/uploads/:fileId/abort
```

## 分享

```http
GET /api/shares
POST /api/shares
Content-Type: application/json

{
  "fileId": "<uuid>",
  "expiresInHours": 168,
  "maxDownloads": 20
}
```

创建响应会返回分享 URL；之后也可通过 `GET /api/shares` 再次读取本人创建的链接。旧版本创建且未保存原始令牌的分享需要重新创建一次。撤销：

```http
DELETE /api/shares/:id
```

公开读取：

```http
GET /api/public/shares/:token
GET /api/public/shares/:token/download
```

下载端点支持标准 `Range` 请求。
