# 安全与运维

## 身份与凭据

- 密码使用 PBKDF2-SHA256、随机 16 字节盐和 100,000 次迭代；这是 Cloudflare Workers Web Crypto 当前支持的迭代上限。
- 会话使用 32 字节随机令牌，Cookie 为 `HttpOnly; Secure; SameSite=Lax`，D1 只保存 SHA-256 摘要。
- API Token 和邀请码明文只显示一次，数据库只存摘要；文件分享链接按产品设置允许主人重复查看。
- 所有 Cookie 写操作要求精确同源；Bearer API Token 不依赖 Origin，但必须满足 scope。
- 管理后台和个人凭据设置拒绝 Bearer Token，只接受浏览器会话。

对于高敏感或公开注册实例，建议在 Cloudflare Access、外部 OIDC 或企业身份提供商后运行。

## R2 Secret

创建只覆盖目标桶的 Object Read & Write Token。不要：

- 使用 Global API Key
- 把 Secret 写入 Git、前端 bundle 或普通环境变量
- 在客户端生成签名
- 让签名有效期超过业务需要

预签名 URL 是 bearer token。项目默认 15 分钟，并且每个 URL 只指向一个对象分片。

## 多账号节点签名

Wrangler-only 的 Storage Node 方案不会创建或收集附加账号的 R2 S3 Secret：

- 本机助手首次连接节点时生成 P-256 密钥对。
- 私钥通过 stdin 写入主 Worker Secret `STORAGE_FEDERATION_PRIVATE_KEY`，不会进入参数、D1、日志或浏览器存储。
- 每个节点只取得公钥、自己的 `NODE_ID` 和主网盘 Origin。
- 主 Worker 的 capability v2 签名绑定节点 ID、HTTP 方法、完整路径、时间戳、随机请求 ID、所有 POST JSON 的 SHA-256 摘要，以及下载请求的实际 `Range`。PUT 大分片不在签名前缓存或摘要整片，授权边界由节点、upload ID、对象 key 和 part number 的完整路径确定，传输内容依赖 HTTPS 完整性。
- Storage Node 是无状态 Worker，不保存或消费随机请求 ID；同一份完整请求在 60 秒窗口内可以原样重放，`multipart/create` 等操作也可能因此重复执行。随机值只用于区分签名请求，不应被理解为服务端防重放存储；节点入口必须始终使用 HTTPS，调用方也只能把自动重试用于已经实现幂等校验的操作。
- 节点输入会再次限制对象 key、upload ID、part number、清单大小和批量删除数量。
- 节点没有登录、目录、D1 或其他 Cloudflare 账号权限，只能操作自己的 `FILES` binding。

管理员页面创建的登记令牌 60 分钟到期、只使用一次，D1 只保存 SHA-256 摘要。这个窗口覆盖 prepare、官方 OAuth/MFA 与多个 Wrangler 阶段；设置页把明文令牌交给本机回环助手后不会写入 localStorage，助手完成节点身份和签名健康检查后才登记。

不同 Cloudflare 登录仍必须由用户在官方 OAuth 页面完成账号密码、MFA 或授权确认。项目不得也不会绕过这一步。

## 主资源归属与防同名误删

安装助手在任何主 R2、D1 或 Worker 写操作前，以 `0600` 权限把随机 installation intent 保存到升级器会保留、Git 会忽略的 `.wrangler/primary-ownership.json`。主桶保存另一份随机 token 标记并记录创建时间；主 Worker 的 Secret `R2_DRIVE_INSTALL_SECRET` 只经 stdin 写入 Cloudflare，卸载时用一次性 challenge 的 HMAC 响应证明线上代码仍是原安装。卸载还要求本机 account、Worker、R2 和 exact D1 `database_id` 全部一致。

R2 桶没有可供 Wrangler 核对的稳定 UUID，因此名称相同不构成所有权证据。标记缺失、创建时间变化、Worker 挑战失败或旧版迁移证据不足时，卸载会在任何云端删除前整体停止；不会现场补写标记、认领同名资源，也不会只删 D1 后丢失恢复依据。旧版自动迁移只有在线 Worker 的 D1/R2 binding 完全匹配，并且 D1 中 ready 文件的 key/size/etag 能与当前桶对象吻合，或空桶创建时间早于 exact D1 创建时间时，才会写入新标记。

## 响应安全头

Worker 对应用响应添加：

- HSTS（仅 HTTPS）
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy`
- `Permissions-Policy`
- `Cross-Origin-Opener-Policy`
- HTML Content Security Policy

CSP 的 `connect-src` 只额外允许 R2 S3 域名，以便直传。

## 分享

分享 token 等同访问密码：

- UI 可选择 1 天、7 天、30 天或长期有效
- API 支持到期与下载次数上限
- 分享管理页可重复查看、复制并随时撤销链接；公开访问仍使用 token 摘要匹配
- 为允许主人再次查看，D1 的 `shares.token_value` 会保存新分享的原始令牌；能读取该 D1 的账号也能取得仍有效的分享链接
- 下载响应支持 Range
- 默认禁止共享缓存
- 开启 `PUBLIC_SHARE_CACHE_SECONDS` 前确认文件允许进入边缘缓存

次数限制在多并发 Range 请求下是近似控制，不应替代 DRM 或强合规下载审计。

文件移入回收站时会立即撤销其分享。启用公开边缘缓存后，已缓存响应仍可能在配置的 TTL 内可取，因此高敏感内容应保持 `PUBLIC_SHARE_CACHE_SECONDS=0`。

## 备份

至少备份：

1. D1 导出：用户、目录结构、对象 key、分享和配额
2. R2 对象：使用另一个桶、账号或外部 S3 兼容存储
3. Wrangler 配置和 Secret 清单：只备份名称与恢复流程，Secret 进入密码管理器
4. `.wrangler/storage-pool` 的非 Secret 节点清单和受权限保护的本机 P-256 恢复材料

定期演练“新 Worker + 新 D1 + 恢复 R2 对象”的完整恢复。

## 日常任务

- 删除过期 `sessions`
- abort 并删除过期 `multipart_uploads`
- 删除过期/已用完 `invitations`
- 对比 `files(status=ready)` 与 R2 对象
- 重算 `users.storage_used`
- 轮换 R2 API Token
- 审阅 `audit_events` 和 Cloudflare Observability

## 供应链

CI 执行类型检查、ESLint、生产构建和产物/路由冒烟测试。上线前还应：

```bash
npm audit
npm outdated
```

不要无条件运行 `npm audit fix --force`；它可能跨主版本破坏 Cloudflare 构建链。对每个报告确认是否进入生产 bundle、是否可利用，再升级。

管理页的一键检查只读取 `oleyyu/R2-Drive-New` 的 GitHub Latest Release，不接收下载地址参数，也不会取得本机 Cloudflare 凭据。实际安装仅由回环地址上的本机助手执行。更新器限制元数据和压缩包体积，只接受 GitHub HTTPS 地址，拒绝符号链接、路径穿越和受保护目录，并校验项目包名、Release 版本、更新清单与必要文件。

更新会保留 `.git`、`.dev.vars`、Wrangler 缓存、依赖缓存、当前 `wrangler.jsonc` 实例资源和本机 CORS。受管理源码先复制到临时备份，完整检查失败时自动恢复。GitHub 账号或正式 Release 本身仍属于供应链信任根；高风险环境可禁用自动安装，改为人工审阅 tag 后按 README 手动升级。
