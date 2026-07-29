# 没有域名：用 DPDNS 免费域名接入 Cloudflare

R2 Drive 必须绑定一个在当前 Cloudflare 账号中处于 **Active** 状态的域名，才能发布和使用。项目不开放 `workers.dev`，也不提供无域名本机版。

如果暂时不想购买域名，可以向 DigitalPlat 申请形如 `你的名字.dpdns.org` 的免费公共名称，再把它的 DNS 托管到 Cloudflare。DigitalPlat 负责注册和委派这个名称，Cloudflare 负责权威 DNS、HTTPS 和 R2 Drive 的 Worker 自定义域名。

> DPDNS 是第三方免费公共名称服务，不是 Cloudflare Registrar，也不由 R2 Drive 维护。免费名称的审批、续期、可用性和规则可能变化；重要或长期服务更建议使用自己购买的域名。

## 准备

- 一个可以登录的 Cloudflare 账号
- 一个可以收验证邮件的邮箱
- DigitalPlat 当前页面要求的账号验证方式；验证要求可能调整，请以申请页面为准

## 第 1 步：申请 `你的名字.dpdns.org`

1. 打开 [DigitalPlat Domains](https://domain.digitalplat.org/)。
2. 注册并登录，按页面完成邮箱或账号验证。
3. 进入域名申请页面，选择 `dpdns.org` 后缀。
4. 输入想要的前缀并检查可用性。例如申请 `mydrive` 后，完整名称是 `mydrive.dpdns.org`。
5. 提交申请，等该名称出现在自己的 DigitalPlat 控制台中。

后续所有地方都要填写完整名称 `mydrive.dpdns.org`，不能只填 `mydrive` 或 `dpdns.org`。

## 第 2 步：先在 Cloudflare 添加完整域名

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)。
2. 选择“添加域”或 “Onboard a domain”。
3. 输入刚申请的完整名称，例如 `mydrive.dpdns.org`。
4. 选择 Free 套餐并继续。
5. 到名称服务器页面后，Cloudflare 会分配两条权威 NS，形如：

   ```text
   xxxxx.ns.cloudflare.com
   yyyyy.ns.cloudflare.com
   ```

这两条值是每个 Zone 实际分配的结果。只复制自己 Cloudflare 页面显示的 NS，不要照抄教程里的示例。

## 第 3 步：把 Cloudflare NS 回填到 DigitalPlat

1. 回到 DigitalPlat，打开 `mydrive.dpdns.org` 的详情或管理页面。
2. 找到 `Nameservers`、`Name Servers` 或 `Custom NS`。
3. 把 Cloudflare 分配的两条 NS 分别填入，删除或替换原来的默认 NS。
4. 检查没有多余空格、拼写错误或混用其他服务商的 NS，然后保存。

DigitalPlat 官方说明其免费名称使用外部权威 DNS：A、AAAA、CNAME、TXT 等记录不在 DigitalPlat 编辑，而是在完成委派后由 Cloudflare 管理。

## 第 4 步：等待 Cloudflare 变为 Active

1. 回到 Cloudflare 的域名概览页。
2. `Pending Nameserver Update` 表示仍在等待 NS 委派生效，不是 R2 Drive 故障。
3. 等状态变为 **Active**。DNS 传播通常需要一些时间，具体时长无法保证。
4. 如果长时间没有生效，依次检查：

   - DigitalPlat 中是不是正好填写了 Cloudflare 给出的两条 NS
   - 有没有照抄别人的示例 NS
   - 是否仍混有 DigitalPlat 默认 NS
   - Cloudflare 中添加的是完整名称 `mydrive.dpdns.org`

## 第 5 步：回 R2 Drive 自动发布

1. 重新打开 `R2-Drive.command` 或 `R2-Drive.bat`。
2. 选择“配置／重新配置”，进入“域名发布”。
3. 点击“重新识别域名”。
4. 选择 Active 的 `mydrive.dpdns.org`。安装助手默认生成：

   ```text
   drive.mydrive.dpdns.org
   ```

5. 点击“一键发布并自动绑定”。
6. 发布完成后，从“打开线上网盘”创建主人账号。

不要预先给 `drive.mydrive.dpdns.org` 手动添加 A 或 CNAME。R2 Drive 使用 Cloudflare Workers Custom Domain，Cloudflare 会在部署时创建所需 DNS 并签发 HTTPS 证书。只有错误明确提示同名 CNAME 冲突时，才删除该主机名原有的 CNAME 后重试。

## 常见问题

### Cloudflare 不接受 `mydrive.dpdns.org`

确认输入的是完整免费名称，且使用的是 DigitalPlat 当前标记可用、能够委派到外部 NS 的后缀。Cloudflare 免费套餐的完整 Zone 接入依赖 Public Suffix List；不同免费后缀的兼容状态可能不同。本文只推荐已由 DigitalPlat 标记可用的 `dpdns.org`。

### Cloudflare 已 Active，安装助手仍找不到

- 确认 R2 Drive 登录的是包含该 Zone 的同一个 Cloudflare 账号。
- 在向导第一步重新连接账号，再点“重新识别域名”。
- 确认 Cloudflare Zone 状态是 Active，而不只是 DNS 记录已经创建。

### 发布提示 CNAME 已存在

进入 Cloudflare → 该域名 → DNS → Records，找到与最终网盘地址完全相同的 CNAME，例如 `drive.mydrive.dpdns.org`。确认它不是其他服务正在使用后删除，再回安装助手重试。不要删除根域名的其他邮件、验证或业务记录。

### 免费域名适合放重要数据吗

R2 文件在自己的 Cloudflare R2 桶中，但域名是访问入口。DigitalPlat 的服务条款不保证免费名称永久保留、持续解析或始终可用。请独立备份 R2 和 D1；重要实例建议购买自己可长期控制的域名。

## 核实来源

本文于 2026-07-29 根据以下在线资料核实：

- [DigitalPlat Domains 官方站](https://domain.digitalplat.org/)：`*.dpdns.org` 可申请，并支持连接外部 Nameservers
- [DigitalPlat FreeDomain 官方教程索引](https://github.com/DigitalPlatDev/FreeDomain/blob/main/documents/tutorial/index.md)：DigitalPlat 负责外部 NS 委派，不提供普通 DNS 记录编辑器
- [Cloudflare：接入域名并更换 Nameservers](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)
- [Cloudflare Workers：Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [DigitalPlat 服务条款](https://domain.digitalplat.org/terms-of-service/)：免费名称、委派、解析和持续可用性不作保证
