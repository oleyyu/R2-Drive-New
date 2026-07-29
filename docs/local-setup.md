# 本地安装手册

R2 Drive 是开源自托管项目，不提供由项目作者管理的共享实例。每一个使用者都在自己的电脑上运行安装助手，登录自己的 Cloudflare 账号，并创建一套独立 D1、R2 与 Worker。默认只有主人账号可以登录，分享链接仍可供别人下载。

## 双击启动

项目根目录提供两个面向普通用户的启动器：

| 系统 | 双击文件 | 功能 |
| --- | --- | --- |
| macOS | `R2-Drive.command` | 检查 Node.js 并显示打开、配置、删除、更新菜单 |
| Windows | `R2-Drive.bat` | 检查 Node.js 并显示打开、配置、删除、更新菜单 |

首次使用选择“2. 配置／重新配置”；配置完成后，每次选择“1. 打开网盘【已配置完毕】”即可。普通用户不必看懂或输入 localhost 地址。启动器不会读取或上传浏览器密码，也不会把 Cloudflare 凭据发送给项目作者。Node.js 缺失或版本过旧时，会打开 Node.js 官方下载页；安装完成后再次双击即可。

macOS 从浏览器下载的未签名脚本可能首次被系统拦截，此时右键 `R2-Drive.command` 并选择“打开”。安装助手运行时要保留终端窗口；关闭它只会停止本机配置助手，不会停止已经发布到 Cloudflare 的线上网盘。

## 命令行启动

```bash
git clone https://github.com/oleyyu/R2-Drive-New.git
cd R2-Drive-New
npm install
npm run setup
```

双击启动后选择第 2 项会自动打开图形化页面，普通用户不需要理解或手动输入本机地址。命令行用户默认打开 `http://127.0.0.1:8788`；需要更换端口时：

```bash
R2_DRIVE_SETUP_PORT=8790 npm run setup
```

向导固定监听 `127.0.0.1`，不监听 `0.0.0.0`。关闭启动向导的终端即可停止它。

## 向导实际会做什么

所有系统命令都采用固定参数数组执行，不接受浏览器提交任意 shell 文本。

| 操作 | 调用 | 是否改动 Cloudflare |
| --- | --- | --- |
| 检查账号 | `wrangler whoami --json` | 否 |
| 登录 | `wrangler login` | 建立当前电脑的 OAuth 登录 |
| 自动识别域名 | Cloudflare 官方 `GET /zones` | 否，只读取所选账号的 Active Zone |
| 检查或新建 D1 | `wrangler d1 list --json`、`wrangler d1 create <名称> --location apac` | 只在没有同名数据库时新建 |
| 检查 R2 | `wrangler r2 bucket info <名称> --json` | 否，确认当前账号是否已有同名桶 |
| 一键创建 R2 | `wrangler r2 bucket create <名称> --location apac` | 是，只在用户点击创建按钮后执行 |
| 上传优化 | `wrangler r2 bucket local-uploads enable <桶>` | 是，开启桶设置 |
| CORS | `wrangler r2 bucket cors set <桶> --file ...` | 是，替换桶的 CORS |
| 数据库迁移 | `wrangler d1 migrations apply <库> --remote` | 是，创建或升级表 |
| 本地 Secret | 写入 `.dev.vars`，权限 `0600` | 否 |
| 生产 Secret | `wrangler secret put <固定名称>` | 是，写入当前 Worker |
| 部署 | `npm run check` 后运行 `npm run deploy` | 是，仅在明确勾选后 |
| 检查更新 | 读取本仓库的 GitHub Latest Release | 否 |
| 安装更新 | 备份后下载、校验、测试、迁移并运行 `npm run deploy` | 是，仅在更新页明确勾选后 |
| 清空 R2 | Cloudflare 官方 R2 Object API 分页列出并删除对象 | 是，仅在菜单第 3 项输入 `DELETE` 后 |
| 删除 R2 | `wrangler r2 bucket delete <桶>` | 是，清空对象后删除当前桶 |
| 删除 D1 | `wrangler d1 delete <库> --skip-confirmation` | 是，先核对当前实例保存的数据库编号 |
| 删除 Worker | `wrangler delete <名称> --force` | 是，同时解除当前 Worker 的自定义域名绑定 |

项目不包含账号 Token、预设 D1 ID、预设托管项目 ID 或共享 R2 桶。向导会修改当前克隆中的 `wrangler.jsonc`；这正是该部署者的实例配置。公开派生仓库前，可清除自己的 `database_id`、Account ID 和域名。它们通常不是密码，但会暴露资源标识。

## 小白流程

### 连接 Cloudflare

点击“连接 Cloudflare”。未登录时，安装助手会显示“打开官方授权”，在 Cloudflare 官方页面完成登录即可。向导不会要求 Global API Key。

如果机器无法自动打开浏览器，也可以另开终端：

```bash
npx wrangler login
```

### 准备私人网盘

安装助手会先要求选择“有没有 Cloudflare 账号”和“R2 是否已绑定付款卡”。选择“还未绑定”时，先打开 R2 控制台按提示添加付款方式并启用 R2；回到助手选择“已经绑定”后才能进入下一页。随后填写桶名称并点击“一键创建 R2 桶（网盘）”；助手会在当前选中的账号中创建私人 APAC R2 桶，已有同名桶时会直接复用，不会重复创建。

也可以选择手动创建 R2：

1. 打开 [Cloudflare R2 控制台](https://dash.cloudflare.com/?to=/:account/r2)，进入 R2 Object Storage 并选择 Create bucket。
2. 名称使用 3-63 个小写字母、数字或连字符。
3. Location 可选择 Asia-Pacific（APAC），也可以保留 Cloudflare 推荐的 Automatic。
4. 保持桶为私有，不要开启 Public Development URL。
5. 复制存储桶名称，回到安装助手填写。

填写网盘名称和存储桶名称后，如果没有桶就先点击“一键创建 R2 桶（网盘）”，再点击“检查并连接存储”。向导默认执行：

- 验证当前 Cloudflare 账号中确实存在这个 R2 存储桶；用户点击创建按钮时自动创建。
- 检查同名 D1：已经存在就自动读取编号并复用，没有时才创建 APAC D1。
- 开启 R2 Local Uploads。
- 写入只允许当前网盘地址的 CORS。
- 执行数据库迁移。
- 设置为私人主人模式，并为大文件启用自动分片和代理回退。

域名发布完成后，管理员可在网盘“个人设置 → 上传加速”点击一次。设置页会自动切换为 80 MiB 分片、6 路并发，并通知本机助手用 Wrangler 开启和复核 Local Uploads、同步 CORS；不需要打开 Cloudflare 页面或粘贴任何密钥。为了让本机助手保持可用，请通过 `R2-Drive.command` / `R2-Drive.bat` 的“打开网盘”进入。

如果数据库名称已经被当前账号占用，才需要打开“高级设置”，选择使用已有数据库。已有桶的位置不能原地改成 APAC。

### 打开网盘

R2 Drive 必须先绑定域名才能发布和使用，不提供无域名本机版或 `workers.dev` 备用入口。点击“继续检查域名”，发布成功后再打开线上网盘并创建主人账号。登录邮箱和至少 12 位的密码都由你自己设置，邮箱只作为登录名，不会发送验证码；填写两次相同密码后，第一个账号就是主人账号，系统随后拒绝其他注册。

没有付费域名时，按 [DPDNS 免费域名接入 Cloudflare](free-domain-dpdns.md) 申请 `你的名字.dpdns.org`，把 Cloudflare 分配的两条 NS 回填到 DigitalPlat。Cloudflare Zone 变成 Active 后，回到向导点击“重新识别域名”。

若需要在开发环境实测预签名直传，可在 Dashboard 创建只限目标桶、具有 Object Read & Write 权限的 R2 API Token，并保存到 `.dev.vars`。

`.dev.vars` 和向导生成的 `config/r2-cors.local.json` 已被 Git 忽略。不要截图、提交或粘贴 Secret。

### 用自己的域名发布（必需）

Active 域名是发布、打开网盘、创建主人账号和公开分享的共同前提。未绑定域名时，启动器只会打开域名配置页，不会启动本机网盘。

可以从管理控制台点击“绑定域名”。通过启动器打开网盘时，本机会同时准备只监听 `127.0.0.1` 的配置助手，按钮会直接进入域名步骤；若配置助手已经关闭，重新双击启动器并选择“2. 配置／重新配置”。安装助手会使用本机 Wrangler 登录授权，自动读取所选 Cloudflare 账号中的 Active 域名。只有一个域名时直接选中；有多个时默认选择第一个，也允许从简单列表切换。网盘地址默认生成为 `drive.你的域名`，普通用户不需要手动填写。

域名列表只从 Cloudflare 官方 API 读取，OAuth Token 不会返回浏览器、写入项目配置或出现在日志中。点击“一键发布并自动绑定”后，安装助手依次：

1. 把该域名写为 Worker Custom Domain。
2. 关闭 `workers.dev` 和预览地址。
3. 更新应用 Origin 与 R2 CORS。
4. 执行类型、lint、构建和测试。
5. 再次应用远程迁移并部署。
6. 若填写桶级 R2 凭据，通过 Wrangler Secret 写入。

若当前账号没有 Active 域名，向导会直接显示 DPDNS 申请、Cloudflare 添加域、复制 NS、回填 DigitalPlat 和等待 Active 的步骤。已有付费域名可直接使用 Cloudflare 添加域入口；添加完成后点击“重新识别域名”。目标主机名不能已有 CNAME。Cloudflare 会自动创建 DNS 记录和 HTTPS 证书。若自动绑定失败，只有错误明确提示同名 CNAME 冲突时，才删除该主机名原有的 CNAME；处理后回向导重试，不要求用户手写 Worker 路由。

## 完全手动配置

不使用浏览器向导也可以：

```bash
npx wrangler login
npx wrangler d1 create my-drive-db --location=apac
npx wrangler r2 bucket create my-drive-files --location=apac
npx wrangler r2 bucket local-uploads enable my-drive-files
```

把 D1 返回的 `database_id`、桶名和 Account ID 写入 `wrangler.jsonc`。发布时还需加入自己的域名：

```jsonc
{
  "workers_dev": false,
  "preview_urls": false,
  "routes": [
    { "pattern": "drive.example.com", "custom_domain": true }
  ]
}
```

再执行：

```bash
cp config/r2-cors.example.json config/r2-cors.local.json
# 编辑 r2-cors.local.json，只保留最终 HTTPS Origin
npx wrangler r2 bucket cors set my-drive-files --file config/r2-cors.local.json
npx wrangler d1 migrations apply my-drive-db --remote
npm run check
npm run deploy
```

直传 Secret：

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

不配置这两项时，`UPLOAD_MODE=auto` 会使用 Worker 代理回退，功能仍可用；但代理分片受当前 Workers 套餐的请求体限制。

## 重新运行与故障恢复

向导可重复启动。资源已成功创建但后续步骤失败时，不要再次新建同名资源：

1. 在 Dashboard 找到已创建的 D1/R2。
2. 对 D1 选择“绑定已有”并粘贴 `database_id`。
3. 对 R2 选择“绑定已有”并保持原桶名。
4. 再次执行配置；迁移和 Local Uploads 可以安全重试。

若 `wrangler whoami --json` 显示了多个账号，从输入框建议列表中选择目标账号的 Account ID，再创建资源。

若点击“启动并打开网盘”后提示旧服务异常，直接点击“重新启动网盘”，安装助手会自动关闭能确认属于当前项目的旧进程。这不会删除 R2 桶、D1 数据库或更改 Cloudflare 配置。若端口由其他软件占用，助手会为避免误关程序而停止，并在页面显示端口号。

## 一键更新

线上管理页的“程序更新”只负责读取 GitHub 正式版信息，不持有 Wrangler 登录或 Cloudflare 密钥。点击“在本机安装更新”会打开只监听 `127.0.0.1` 的本机助手；如果按钮提示无法连接，先双击启动器选择“1. 打开网盘”，再返回管理页点击一次。也可以直接在启动器选择“4. 检查更新／一键升级”。

安装前必须勾选确认。更新器会下载本项目 GitHub Release、限制下载体积、拒绝符号链接和越界路径，并校验包名、版本与必要文件。随后它备份受管理的源代码和 `wrangler.jsonc`，保留当前 Account ID、D1、R2、域名、容量设置、`.dev.vars` 及本机 CORS，再运行完整检查、远程 D1 迁移和域名 Worker 发布。程序检查或发布前的本地步骤失败时会自动恢复旧版；R2 文件不会参与源码替换。

若当前没有绑定域名，更新器只升级本机程序和数据库，不会凭空创建公网地址。若 Wrangler 官方 OAuth 已过期，需要先在配置助手重新连接 Cloudflare，再重试更新。

## 一键卸载

双击启动器并选择“3. 一键卸载”。终端会从当前 `wrangler.jsonc` 读取并列出准确的 Worker、R2 桶、D1 数据库和自定义域名；只有再次输入大写 `DELETE` 才会开始。启动器会先用 D1 编号和 R2 Object API 做只读预检，确认当前 Cloudflare 账号中的目标与本机配置一致，再删除 Worker 以阻止新的上传。随后它会分页永久删除 R2 对象；若删除桶返回 `10008`，还会自动读取 D1 中的未完成分片上传，通过运行在 Cloudflare 边缘的临时清理 Worker 逐个 abort、再次清空普通对象并重试。可重试的 R2 服务错误会指数退避重试，临时 Worker 会在操作结束后停止。最后删除编号完全匹配的 D1 与本地配置。Cloudflare 的具体规则见 [删除 R2 桶](https://developers.cloudflare.com/r2/buckets/delete-buckets/)、[Multipart Uploads](https://developers.cloudflare.com/r2/objects/multipart-objects/) 与 [List objects API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/)。

删除 R2 桶会一并删除 CORS、生命周期、事件通知和其他桶级配置；删除 Worker 会一并删除 Worker Secret、版本和域名路由。所有云端步骤成功后，启动器才会恢复干净的 `wrangler.jsonc`，并删除 `.dev.vars`、本地 CORS、构建缓存和 Wrangler 项目缓存。项目源代码、Cloudflare 域名专区、其他项目与这台电脑的全局 Wrangler 登录都会保留。手动创建且可能被其他项目共用的 R2 API Token 也不会被代为删除，但其本机副本和 Worker Secret 会清除。

若网络、权限或 Cloudflare API 使任一步失败，本地目标配置会保留，处理提示后再次选择第 3 项即可继续；已经永久删除的文件无法恢复。
