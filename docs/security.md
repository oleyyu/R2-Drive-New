# 安全与运维

## 身份与凭据

- 密码使用 PBKDF2-SHA256、随机 16 字节盐和 100,000 次迭代；这是 Cloudflare Workers Web Crypto 当前支持的迭代上限。
- 会话使用 32 字节随机令牌，Cookie 为 `HttpOnly; Secure; SameSite=Lax`，D1 只保存 SHA-256 摘要。
- API Token 和邀请码明文只显示一次，数据库只存摘要。
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
- 分享管理页可查看状态并随时撤销；数据库只保存 token 摘要，原始链接只在创建时显示一次
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
