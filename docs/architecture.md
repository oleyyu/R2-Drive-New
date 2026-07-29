# 架构与数据模型

## 组件

```text
┌──────────────┐     HTTPS / session      ┌─────────────────────┐
│ Web browser  │ ───────────────────────> │ Cloudflare Worker   │
│ React client │ <─────────────────────── │ vinext App Router   │
└──────┬───────┘      JSON / stream       └──────┬────────┬─────┘
       │                                          │        │
       │ S3 multipart PUT                         │ SQL    │ R2 binding
       │ (short presigned URL)                    ▼        ▼
       └──────────────────────────────────────> R2      Cloudflare D1
```

Worker 是控制面：认证、授权、配额、目录、签名、完成分片、分享和审计。R2 是数据面。直传启用后，Worker 不读取文件分片内容。

## 上传状态机

1. 客户端提交文件名、大小、类型和父目录。
2. Worker 校验用户状态、scope、单文件上限、已用空间和未完成任务预留空间。
3. Worker 创建 R2 Multipart Upload，写入 `files(status=uploading)` 和 `multipart_uploads`。
4. 客户端为每片申请 URL；有 S3 Secret 时取得短期签名，否则向 Worker 代理分片端点 PUT。直传连续失败时，同一分片自动回退代理并指数退避重试。
5. 客户端保存每片的 `partNumber` 与 `ETag`。
6. 完整 ETag 清单提交后，Worker 调用 R2 complete，并用最终对象大小再次校验。
7. 文件变成 `ready`，任务删除，用户 `storage_used` 增加。
8. 任何失败由客户端请求 abort；对象与元数据任务被清理。

## 表

| 表 | 内容 |
| --- | --- |
| `users` | 账号、密码摘要、角色、状态、配额、偏好 |
| `sessions` | HttpOnly 会话令牌摘要与有效期 |
| `files` | 文件夹和文件元数据、对象 key、状态、ETag、固定状态与删除时间 |
| `multipart_uploads` | R2 upload ID、分片大小、预期片数、过期时间 |
| `shares` | 分享令牌摘要、到期、下载上限 |
| `api_tokens` | 开发者令牌摘要、scope、使用时间 |
| `invitations` | 注册邀请码摘要、邮箱限制、次数、到期 |
| `system_settings` | 管理员可热更新的实例设置 |
| `audit_events` | 关键写操作审计 |

对象 key 使用 `${userId}/${fileId}/blob`，不含用户原始文件名，避免路径歧义和隐私泄漏。下载名称来自 D1 并写入安全的 `Content-Disposition`。

## 文件生命周期

文件和文件夹的正常状态为 `ready`。移入回收站时，服务端通过递归查询把整个子树标记为 `deleted`、记录 `deleted_at` 并撤销关联分享，但不立即删除 R2 对象，也不减少用户已用空间。恢复会恢复整个子树；如果原父目录已不存在，则恢复到根目录。永久删除和清空回收站才批量删除 R2 对象、D1 行并扣减实际文件字节。

固定到快捷访问使用 `is_pinned`，只是每用户元数据，不复制对象。

## 容量边界

- R2 桶总数据量与对象数量没有预设总上限。
- 单对象约 4.995 TiB。
- 单次/单分片约 4.995 GiB。
- Multipart Upload 最多 10,000 片。
- D1 中的字节数低于 JavaScript safe integer 边界。

精确限制以 [Cloudflare R2 Limits](https://developers.cloudflare.com/r2/platform/limits/) 为准。

## 一致性

- 文件完成后才计入 `storage_used`。
- 未完成上传通过 `multipart_uploads` 计入预留空间，防止并行超配额。
- R2 complete 后再比较最终对象大小；不匹配会删除异常对象并标记失败。
- D1 和 R2 无法进行跨产品原子事务，因此运维脚本应定期检查孤儿对象和过期上传。当前版本已保存足够的 `storage_key`、`upload_id` 与状态用于实现该任务。
