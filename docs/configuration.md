# 配置手册

本页面向每一个自行部署 R2 Drive 的维护者。不要复制他人的 Account ID、数据库 ID 或 Secret；每个实例必须使用自己的 Cloudflare 资源和最小权限凭据。

## Wrangler bindings

| Binding | 类型 | 用途 | 必填 |
| --- | --- | --- | --- |
| `DB` | D1 | 用户、目录、配额、分享、设置、审计 | 是 |
| `FILES` | R2 | 文件对象与 Multipart Upload | 是 |

`wrangler.jsonc` 中的 binding 名必须与代码保持一致。每个部署者都必须为 D1 项写入自己账号中的 `database_id`；`npm run setup` 会自动完成这一步。

R2 存储桶属于部署者自己的 Cloudflare 账号。安装助手既可以连接已有桶，也可以在用户点击“一键创建 R2 桶（网盘）”后，通过 Wrangler 创建私人 APAC 桶。创建动作只在按钮点击后发生，重复点击会先检查并复用同名桶；向导不会删除 R2。也可以在 [Cloudflare R2 控制台](https://dash.cloudflare.com/?to=/:account/r2) 手动创建，官方步骤见 [Create new buckets](https://developers.cloudflare.com/r2/buckets/create-buckets/)。

## 普通环境变量

这些值可以写在 `wrangler.jsonc` 的 `vars` 中，不属于密码。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_NAME` | `R2 Drive` | 实例显示名称 |
| `APP_ORIGIN` | `http://localhost:3000` | 唯一可信应用 Origin；生产必须是最终 HTTPS 域名 |
| `REGISTRATION_MODE` | 安装助手写入 `closed` | 私人网盘仍允许创建第一个主人账号，随后拒绝其他注册；高级维护者可改为 `open` 或 `invite` |
| `DEFAULT_USER_QUOTA_BYTES` | `10000000000` | 新用户默认配额，默认 10 GB；这是网盘内的安全上限，不会改变 Cloudflare 计费 |
| `MAX_FILE_SIZE_BYTES` | `5492064911360` | 单文件上限，不得超过 R2 的约 4.995 TiB |
| `UPLOAD_PART_SIZE_BYTES` | `67108864` | 优先分片大小，默认 64 MiB；必要时自动增大 |
| `UPLOAD_URL_TTL_SECONDS` | `900` | 分片签名有效期，1 秒至 7 天 |
| `PUBLIC_SHARE_CACHE_SECONDS` | `0` | 公开分享的边缘缓存秒数；`0` 为不缓存 |
| `UPLOAD_MODE` | `auto` | `auto`、`direct` 或 `proxy`；`auto` 先直传、失败时客户端回退代理 |
| `DOWNLOAD_MODE` | `proxy` | `proxy` 经 Worker 流式下载；`direct` 跳转 R2 预签名 URL |
| `R2_BUCKET_NAME` | `r2-drive-files` | 用于构造 S3 预签名 URL |
| `R2_ACCOUNT_ID` | 空 | Cloudflare Account ID；为空时关闭直传 |
| `BOOTSTRAP_ADMIN_EMAILS` | 空 | 逗号分隔的管理员邮箱；首个用户始终是管理员 |

`APP_ORIGIN` 仍为 localhost，或使用 `workers.dev`、`pages.dev`、`trycloudflare.com` 等临时地址时，R2 Drive 会关闭公开分享：前端不显示创建入口，服务端拒绝创建分享和公开下载。只有安装助手成功写入自有 HTTPS 域名后，分享才会开启；即使主人从本机管理网盘，生成的链接也固定使用该公网域名。

修改 `REGISTRATION_MODE`、默认配额和站点名称后，管理后台会把值写入 D1 `system_settings`。数据库值优先于对应启动默认值，便于不重新部署地调整策略。开源安装助手默认选择 `closed`，并通过原子数据库写入保证并发情况下也只会产生一个首位主人。

安装助手会尽力读取当前账号的 Workers 默认计费模型并显示免费版、付费版、旧版或企业版。普通 Wrangler 授权通常不能读取完整账单，因此无法确定时会明确提示到 Cloudflare 账单页核对，不会猜测。Workers 套餐与 R2 免费层是两套计费：R2 Standard 当前免费层为每月 10 GB-month、100 万次 Class A、1000 万次 Class B，公网出站流量免费；不是 15 GB，且免费层不适用于 Infrequent Access。存储用量按账期内每天峰值的平均值计算，应用内 10 GB 配额只是一道防超额保护，操作次数仍可能产生费用。最新额度以 [Cloudflare R2 Pricing](https://developers.cloudflare.com/r2/pricing/) 为准。

## Secret

| Secret | 说明 |
| --- | --- |
| `R2_ACCESS_KEY_ID` | R2 API Token 的 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | R2 API Token 的 Secret Access Key |
| `R2_DRIVE_INSTALL_SECRET` | 主 Worker 安装身份的 HMAC Secret；安装助手自动生成并通过 stdin 写入 |
| `STORAGE_FEDERATION_PRIVATE_KEY` | 多账号存储池主 Worker 的 P-256 private JWK；本机助手自动生成并通过 stdin 写入 |

不要把 Secret 写进 `wrangler.jsonc`、`.env` 样例或 Git：

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

凭据只需要目标桶的 Object Read & Write 权限。不要使用全账号管理员 Token。两项中任意一项缺失时，前端会自动切换到 Worker 代理上传；代理分片必须小于你 Cloudflare 账号的 Worker 入站请求限制。

附加账号不使用这两项 R2 Secret。每个附加账号由 Wrangler 部署一个绑定自身桶的 Storage Node Worker，节点配置只包含非 Secret 的 `NODE_ID`、`CONTROL_PUBLIC_KEY_JWK` 和 `CONTROL_ORIGIN`。本机节点清单与 P-256 恢复材料保存在被 Git 忽略且升级器保留的 `.wrangler/storage-pool` 中。

目标账号必须事先启用 R2，并完成 Cloudflare 要求的付款方式设置；Wrangler
不能代办账单。满足此前置条件后，助手会自动完成桶、Local Uploads、Worker
和登记配置，除官方 OAuth／MFA 外不需要人工复制密钥。

连接助手会在任何 Cloudflare 写操作前先把节点 provisioning intent 写入该清单，并在创建桶、开启 Local Uploads、部署 Worker 和登记成功后逐步更新。复用已有桶时，卸载只清理 R2 Drive 自己的 UUID 对象前缀并保留桶；助手开启的 Local Uploads 也是桶级配置，不会在卸载时擅自恢复或覆盖其他桶设置。

## R2 CORS

把 `config/r2-cors.example.json` 中的 Origin 替换为所有合法前端 Origin。生产环境不要保留不使用的域名，也不要写 `*`。

必须满足：

- `PUT` 方法可用
- `Content-Type` 可作为请求头
- `ETag` 出现在 `exposeHeaders`
- Origin 必须与浏览器地址栏的 scheme、host、port 完全一致

预签名 URL 只能用于 S3 API 域名，不能改成 R2 自定义域名。参见 [Cloudflare 预签名 URL 文档](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)。

## 上传参数

实际分片大小为：

```text
max(
  UPLOAD_PART_SIZE_BYTES,
  ceil(文件大小 / 10000)，再向上取整至 1 MiB
)
```

并被限制在 R2 分片合法区间。浏览器默认同时上传 3 片，并会读取个人设置中的 1–8 并发偏好；弱网、均衡和高吞吐网络档位会调整优先分片大小。

建议：

- Worker Free/Pro 代理模式：分片不超过 64 MiB
- 直传模式：64–256 MiB，移动网络优先较小分片
- 数 TiB 文件：系统会自动增大，不要手动强压成超过 10,000 片

## 下载模式

### `proxy`

Worker 通过 R2 binding 流式返回对象，支持 `Range`。优点是访问始终使用应用域名，并利用 Cloudflare 到 R2 的内部集成；缺点是所有下载都产生 Worker 请求和执行开销。

### `direct`

Worker 验证权限后返回 302 到短期 S3 预签名 GET URL。数据不穿过 Worker，适合链路稳定的用户和大文件；该 URL 不能使用自定义域名。

### 公开分享缓存

`PUBLIC_SHARE_CACHE_SECONDS > 0` 会把无下载次数限制的公开分享放入 Cloudflare 边缘缓存。本地向导提供关闭、1 小时和 1 天三个选项，也可手动设置为 0–604800 秒。这只适用于你确认可以缓存的分享内容；链接撤销或过期最多会延迟一个 TTL。私有账号下载始终 `private, no-store`。

## 管理后台

管理员可配置：

- 站点名称
- 开放 / 仅邀请 / 关闭注册
- 新用户默认配额
- 每用户角色、状态与配额
- 附加 Cloudflare R2 节点、节点写入状态和软容量预算
- 可限制邮箱、有效期和使用次数的邀请码

邀请码明文只显示一次；D1 只保存 SHA-256 摘要。API 令牌同理。

## 多环境

推荐分别创建 `development`、`staging`、`production` 的 D1、R2 和 R2 Token，绝不共用生产桶。使用 Wrangler environment 时，在每个环境中明确重复非继承 binding 和变量，并给桶名加后缀。
