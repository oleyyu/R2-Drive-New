# 本地安装手册

R2 Drive 是开源自托管项目，不提供由项目作者管理的共享实例。每一个使用者都在自己的电脑上运行安装助手，登录自己的 Cloudflare 账号，并创建一套独立 D1、R2 与 Worker。默认只有主人账号可以登录，分享链接仍可供别人下载。

## 双击启动

项目根目录提供两个面向普通用户的启动器：

| 系统 | 双击文件 | 功能 |
| --- | --- | --- |
| macOS | `R2-Drive.command` | 检查 Node.js 并显示打开、配置、删除菜单 |
| Windows | `R2-Drive.bat` | 检查 Node.js 并显示打开、配置、删除菜单 |

首次使用选择“2. 配置／重新配置”；配置完成后，每次选择“1. 打开网盘【已配置完毕】”即可。普通用户不必看懂或输入 localhost 地址。启动器不会读取或上传浏览器密码，也不会把 Cloudflare 凭据发送给项目作者。Node.js 缺失或版本过旧时，会打开 Node.js 官方下载页；安装完成后再次双击即可。

macOS 从浏览器下载的未签名脚本可能首次被系统拦截，此时右键 `R2-Drive.command` 并选择“打开”。安装助手和本地网盘运行时要保留终端窗口，关闭它就会停止本地服务。

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

安装助手会先要求选择“有没有 Cloudflare 账号”和“有没有 R2 存储桶”。选择“还没有”后，连接 Cloudflare 并进入下一页，填写桶名称，再点击“一键创建 R2 桶（网盘）”。助手会在当前选中的账号中创建私人 APAC R2 桶；已有同名桶时会直接复用，不会重复创建。

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

如果数据库名称已经被当前账号占用，才需要打开“高级设置”，选择使用已有数据库。已有桶的位置不能原地改成 APAC。

### 打开网盘

如果准备绑定自己的域名，请先点击“有域名：先发布域名”，发布成功后再打开域名网盘并创建主人账号。这样账号和密码只设置一次；以后双击启动器选择“打开网盘”也会直接进入域名版。

只有确定不使用域名时，才点击“没有域名：打开本机版”。安装助手会依次显示“启动服务、编译页面、检查账号页、打开网盘”的真实进度，成功后自动跳转。第一次打开会进入“创建主人账号”：登录邮箱和至少 12 位的密码都由你自己设置，邮箱只作为登录名，不会发送验证码。填写两次相同密码后，第一个账号就是主人账号，系统随后拒绝其他注册。

若以前启动的本地网盘没有正常退出，直接点击“重新启动网盘”。助手会核对占用端口的进程路径和项目目录，只在确认它属于当前 R2 Drive 项目后自动关闭旧进程，再启动新网盘，不需要手动寻找旧终端。无法确认身份的其他软件不会被强制关闭。启动失败或超过两分钟时也会停止等待并显示恢复方法；“查看错误详情”只在排查问题时使用。

若需要实测预签名直传，可在 Dashboard 创建只限目标桶、具有 Object Read & Write 权限的 R2 API Token，再通过安装助手的可选区域保存到 `.dev.vars`。

`.dev.vars` 和向导生成的 `config/r2-cors.local.json` 已被 Git 忽略。不要截图、提交或粘贴 Secret。

### 用自己的域名发布（可选）

发布不是本机上传、整理和主人下载的必要条件，但公开分享只有绑定自己的域名并完成发布后才会开启。未绑定域名时，文件列表不显示分享操作，创建分享与公开下载接口也会拒绝请求，避免生成别人无法打开的 localhost 链接。

Cloudflare 的本机开发数据库与线上 D1 是两个独立环境，所以不要先在本机版创建账号再改用域名版。向导会先准备两边所需的数据表，但不会复制账号密码或文件。发布域名后，启动器固定打开域名版，避免以后误入另一套本机账号。

可以从管理控制台点击“绑定域名”。通过启动器打开网盘时，本机会同时准备只监听 `127.0.0.1` 的配置助手，按钮会直接进入域名步骤；若配置助手已经关闭，重新双击启动器并选择“2. 配置／重新配置”。安装助手会使用本机 Wrangler 登录授权，自动读取所选 Cloudflare 账号中的 Active 域名。只有一个域名时直接选中；有多个时默认选择第一个，也允许从简单列表切换。网盘地址默认生成为 `drive.你的域名`，普通用户不需要手动填写。

域名列表只从 Cloudflare 官方 API 读取，OAuth Token 不会返回浏览器、写入项目配置或出现在日志中。点击“一键发布并自动绑定”后，安装助手依次：

1. 把该域名写为 Worker Custom Domain。
2. 关闭 `workers.dev` 和预览地址。
3. 更新应用 Origin 与 R2 CORS。
4. 执行类型、lint、构建和测试。
5. 再次应用远程迁移并部署。
6. 若填写桶级 R2 凭据，通过 Wrangler Secret 写入。

若当前账号没有 Active 域名，向导会给出 Cloudflare 添加域名入口；添加完成后点击“重新识别域名”即可。目标主机名不能已有 CNAME。Cloudflare 会自动创建 DNS 记录和 HTTPS 证书。若自动绑定失败，向导会直接显示小白处理方法：先在 Cloudflare 的 DNS 页面删除同名 CNAME，确认根域名状态为 Active，再回到向导重试；不要求用户手写 Worker 路由。

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

## 删除当前实例

双击启动器并选择“3. 删除所有信息”。终端会从当前 `wrangler.jsonc` 读取并列出准确的 R2 桶、D1 数据库、Worker 和自定义域名；只有再次输入大写 `DELETE` 才会开始。R2 桶必须先清空才能删除，因此启动器会通过 Cloudflare 官方 Object API 分页永久删除桶中对象，再依次删除桶、编号完全匹配的 D1 和 Worker。Cloudflare 的具体规则见 [删除 R2 桶](https://developers.cloudflare.com/r2/buckets/delete-buckets/) 与 [List objects API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/)。

所有云端步骤成功后，启动器才会恢复干净的 `wrangler.jsonc`，并删除 `.dev.vars`、本地 CORS、构建缓存和 Wrangler 项目缓存。项目源代码与这台电脑的全局 Wrangler 登录都会保留，Cloudflare 账号中的其他资源不会被处理。若网络、权限或 Cloudflare API 使任一步失败，本地目标配置会保留，处理提示后再次选择第 3 项即可继续；已经永久删除的文件无法恢复。
