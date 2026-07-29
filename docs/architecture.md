# 架构与数据模型

## 组件

```text
┌──────────────┐     HTTPS / session      ┌─────────────────────┐
│ Web browser  │ ───────────────────────> │ Main Worker         │
│ React client │ <─────────────────────── │ vinext App Router   │
└──────┬───────┘      JSON / stream       └───┬──────┬──────┬──┘
       │                                       │      │      │ signed HTTPS
       │ S3 multipart PUT                      │ SQL  │      ▼
       │ (primary direct mode)                 ▼      ▼   Storage Node Worker(s)
       └────────────────────────────────────> R2     D1          │
                                                              R2 binding
```

Worker 是控制面：认证、授权、配额、目录、签名、完成分片、分享和审计。R2 是数据面。直传启用后，Worker 不读取文件分片内容。

主账号的 R2 继续使用原生 `FILES` binding。附加 Cloudflare 账号不能跨账号绑定到主 Worker，因此每个账号由 Wrangler 部署一个 Storage Node Worker；它只拥有该账号内目标桶的原生 binding。主 Worker 使用短时 P-256 capability 通过 HTTPS 调用节点，不保存附加账号的 R2 S3 凭据。

## 上传状态机

1. 客户端提交文件名、大小、类型和父目录。
2. Worker 校验用户状态、scope、单文件上限、已用空间和未完成任务预留空间。
3. Worker 按节点软容量和当前使用率选择一个存储节点并原子预留空间；没有可用附加节点时选择主桶。
4. Worker 在选定节点创建 R2 Multipart Upload，写入 `files(status=uploading)`、`storage_node_id` 和 `multipart_uploads`。一个任务创建后不会跨节点续传。
5. 主桶有 S3 Secret 时客户端可取得短期直传 URL；附加节点使用主 Worker 到节点的签名流式代理。
6. 客户端保存每片的 `partNumber` 与 `ETag`。
7. 完整 ETag 清单提交后，Worker 在同一节点调用 complete，并用最终对象大小再次校验。
8. 文件变成 `ready`，任务删除，节点预留转为已用，用户 `storage_used` 增加。
9. 任何失败由客户端请求 abort；对象、节点预留与元数据任务被清理。

## 表

| 表 | 内容 |
| --- | --- |
| `users` | 账号、密码摘要、角色、状态、配额、偏好 |
| `sessions` | HttpOnly 会话令牌摘要与有效期 |
| `files` | 文件夹和文件元数据、对象 key、状态、ETag、固定状态与删除时间 |
| `multipart_uploads` | R2 upload ID、分片大小、预期片数、过期时间 |
| `storage_nodes` | 附加账号节点、R2 桶、HTTPS endpoint、状态、软容量、已用与预留 |
| `storage_node_enrollments` | 管理员创建的短时一次性节点登记令牌摘要 |
| `shares` | 分享令牌摘要、到期、下载上限 |
| `api_tokens` | 开发者令牌摘要、scope、使用时间 |
| `invitations` | 注册邀请码摘要、邮箱限制、次数、到期 |
| `system_settings` | 管理员可热更新的实例设置 |
| `audit_events` | 关键写操作审计 |

对象 key 使用 `${userId}/${fileId}/blob`，不含用户原始文件名，避免路径歧义和隐私泄漏。下载名称来自 D1 并写入安全的 `Content-Disposition`。

`files.storage_node_id` 与 `multipart_uploads.storage_node_id` 为空时表示旧版主桶；非空时指向一个 Storage Node。永久删除会先按节点分组，再分别删除对象。当前网页只允许暂停节点的新写入，不执行仅删除 D1 的单点断开；删除全部节点必须由本机一键卸载同时核对本机清单、Cloudflare 资源和 D1，避免产生无法定位的孤儿对象。

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
- 附加节点用条件 `UPDATE` 原子增加 `reserved_bytes`；complete 时转入 `used_bytes`，abort 时释放。
- R2 complete 后再比较最终对象大小；不匹配会先删除异常对象，再释放预留并删除未发布的上传元数据。
- D1 和 R2 无法进行跨产品原子事务，因此运维脚本应定期检查孤儿对象和过期上传。当前版本已保存足够的 `storage_key`、`upload_id` 与状态用于实现该任务。
