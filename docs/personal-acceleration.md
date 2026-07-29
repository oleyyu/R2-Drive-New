# 普通用户网络优化

本方案只使用普通 Cloudflare 账号能直接启用的功能。

## 先说结论

没有中国内地节点时，任何方案都不能保证全国三网稳定低延迟。个人部署能做的是：

1. 让写入尽量在上传者附近落地。
2. 避免一次网络抖动毁掉整个大文件。
3. 在 R2 直连不佳时自动换到应用域名代理。
4. 对允许公开缓存的下载减少重复跨区域读取。
5. 使用 QUIC/HTTP/3 改善有丢包链路的队头阻塞。

项目已经实现第 2–4 项；第 1 和第 5 项需在 Cloudflare 控制台或 Wrangler 开启。

## 1. 新桶选择 APAC

创建新桶时指定亚洲位置偏好：

```bash
npx wrangler r2 bucket create r2-drive-files --location=apac
```

Cloudflare 说明 Location Hint 是尽力而为的存放位置偏好，不是保证，而且只在第一次创建桶时生效。已有桶不能原地修改；如需迁移，应新建 APAC 桶并复制对象。参见 [R2 Data location](https://developers.cloudflare.com/r2/reference/data-location/)。

## 2. 开启 R2 Local Uploads

这是最值得先开的项目：

```bash
npx wrangler r2 bucket local-uploads enable 你的桶名
```

Local Uploads 会让 `PutObject` 和 `UploadPart` 先写入靠近客户端的位置，再异步复制到主桶；对象立即可读并保持强一致。Cloudflare 当前说明该功能不额外收费，只收正常 Class A 操作费。参见 [R2 Local uploads](https://developers.cloudflare.com/r2/buckets/local-uploads/)。

注意：

- 它优化上传，不会把下载内容永久复制到所有边缘。
- 带 jurisdiction restriction 的桶不支持。
- 上传完成后从其他地区立即读取，复制完成前仍可能产生跨区域读取延迟。

## 3. 使用自动直传 + Worker 回退

`UPLOAD_MODE` 有三种值：

| 值 | 行为 | 建议 |
| --- | --- | --- |
| `auto` | 有 S3 凭据时先直传；单片直传连续失败后自动改走 Worker | 默认 |
| `direct` | 服务端签发直传地址；客户端仍保留故障回退 | 全球链路稳定 |
| `proxy` | 所有分片经应用域名和 Worker R2 binding | R2 S3 域名在本地网络明显不稳定 |

普通用户建议先用 `auto`。如果同一地点连续多次回退，改为：

```jsonc
"UPLOAD_MODE": "proxy"
```

代理分片受 Worker 入站请求体限制，所以项目的三个网络 profile 都保持在 100 MB 以下。

## 4. 弱网分片、并发和重试

个人设置提供：

| Profile | 分片 | 适用 |
| --- | --- | --- |
| 弱网稳定 | 16 MiB | 移动网络、丢包高、频繁中断 |
| 均衡 | 64 MiB | 默认 |
| 高吞吐 | 80 MiB | 稳定宽带、减少 Class A 操作 |

并行度可在 1–8 调整。建议：

- 移动网络：2–3
- 普通家庭宽带：3–4
- 高质量上行：5–8

每个分片会指数退避重试。直传失败两次后改用 Worker 代理，再重试三次；已成功分片不会重传。R2 官方也将 Multipart 推荐用于需要并行和可恢复的大文件，并建议对 429/5xx 使用重试与退避。参见 [R2 Upload objects](https://developers.cloudflare.com/r2/objects/upload-objects/) 与 [R2 Error codes](https://developers.cloudflare.com/r2/api/error-codes/)。

## 5. 私有下载走应用域名

中国内地访问 S3 endpoint 不稳定时，使用：

```jsonc
"DOWNLOAD_MODE": "proxy"
```

Worker 通过 R2 binding 流式返回文件并支持 `Range`，用户只连接你的 `drive.example.com`。这不会提供内地节点，但能避免浏览器再跳到 `r2.cloudflarestorage.com`，并利用 Cloudflare 的 Worker/R2 集成。

如果实测 S3 直下更快，再改成 `direct`。不要凭印象决定，应对同一文件从目标网络分别测两种模式。

## 6. 公开分享使用边缘缓存

只有可以公开缓存、且没有下载次数限制的分享适合开启：

```jsonc
"PUBLIC_SHARE_CACHE_SECONDS": "3600"
```

项目使用 `caches.default` 保存完整的 `200` 响应；后续 Range 请求可从完整缓存切片。缓存只存在于处理请求的边缘位置，不会自动复制到所有节点，也不支持 Tiered Cache。Cloudflare Free/Pro/Business 单文件可缓存上限为 512 MB。参见 [Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) 和 [R2 cache limits](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/)。

风险：

- 分享撤销或到期后，缓存最多继续存活一个 TTL；代码会把 TTL 截断到分享到期时间。
- 带下载次数限制的分享永不缓存。
- 私有下载永不缓存。
- 超过平台可缓存大小的文件仍正常下载，只是不会命中缓存。

## 7. 开启 HTTP/3

在 Cloudflare Dashboard：

```text
域名 → Speed → Settings → Protocol Optimization → HTTP/3 → On
```

HTTP/3 对所有套餐可用。QUIC 消除了 TCP 层的队头阻塞，在高丢包网络上通常更稳；它只作用于用户到 Cloudflare 的连接。参见 [Cloudflare HTTP/3](https://developers.cloudflare.com/speed/optimization/protocol/http3/)。

## 8. Smart Placement

`wrangler.jsonc` 已开启：

```jsonc
"placement": { "mode": "smart" }
```

Cloudflare 会根据真实请求耗时，判断 Worker 靠近用户运行还是转发到更接近 D1/R2 上游的位置。Smart Placement 只会在收益明显时转发，并保留少量基线请求用于比较。参见 [Workers Placement](https://developers.cloudflare.com/workers/configuration/placement/)。

如果实例主要只提供静态页面、几乎不访问 D1/R2，可在实测后删除该配置。

## 9. 自定义域名与 CORS

- 应用必须使用你自己的 HTTPS 域名。
- R2 直传仍只能使用 S3 API 域名；不能把签名 URL 换成自定义域名。
- R2 CORS 必须允许应用 Origin、`PUT` 和 `Content-Type`，并暴露 `ETag`。
- 不要把私有文件桶直接改成 public bucket。

预签名 URL 限制见 [R2 Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)。

## 10. 实测方式

从实际使用网络分别测：

1. 16 MiB、64 MiB、1 GiB 上传。
2. `UPLOAD_MODE=auto` 与 `proxy`。
3. 并发 2、4、6。
4. `DOWNLOAD_MODE=proxy` 与 `direct`。
5. Wi‑Fi 与移动网络。
6. 电信、联通、移动至少各一个入口。

记录成功率、P50/P95 速度和重试次数。选择最稳定的组合，不要只看一次峰值。
