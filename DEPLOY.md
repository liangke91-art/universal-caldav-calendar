# 部署与跨电脑接入

下面的 GitHub Client Secret、CalDAV 用户名和密码都不要发到聊天里，也不要写进仓库。项目中的示例文件只有空占位符。

## 1. 账号与费用

需要三个已注册账号：

1. GitHub：创建私有仓库和免费的 OAuth App；
2. Cloudflare：在 Workers Free 上运行远程 MCP；
3. fruux 或其他 CalDAV：保存日历并与 HarmonyOS 同步。

本方案不需要 Cloudflare Zero Trust、银行卡、域名或云服务器。免费额度和条款可能变化，以服务商当前页面为准。

## 2. 创建 GitHub OAuth App

打开 GitHub 的 `Settings → Developer settings → OAuth Apps → New OAuth App`，填写：

```text
Application name: Universal CalDAV Calendar
Homepage URL: https://universal-caldav-calendar.liangke91.workers.dev
Authorization callback URL: https://universal-caldav-calendar.liangke91.workers.dev/callback
```

点击 `Register application` 后：

- 复制 Client ID；
- 点击 `Generate a new client secret`，按 GitHub 要求完成验证；
- 只在 Cloudflare Worker 的 Secrets 页面保存 Client Secret；不要提交到 Git。

本项目发送 GitHub 授权请求时不声明额外 scope，因此不申请仓库、私有邮箱或代码权限。

## 3. 配置 Cloudflare Worker

项目已包含 Worker URL 和两个 KV ID。生产环境只需要三个 secrets：

```text
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
CREDENTIALS_MASTER_KEY
```

其中 `CREDENTIALS_MASTER_KEY` 必须是随机 32 字节值的 Base64 编码。可以在本机项目目录运行下面的命令，让 Wrangler 安全提示输入；不要把真实值直接写在命令后面：

```powershell
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | npx wrangler secret put CREDENTIALS_MASTER_KEY
```

也可以在 Cloudflare Dashboard 的 Worker 设置里逐项添加。GitHub 登录白名单、默认时区和提醒时间是非敏感变量，已在 `wrangler.jsonc` 中配置：

```text
ALLOWED_GITHUB_LOGINS=liangke91-art
DEFAULT_TIMEZONE=Asia/Shanghai
DEFAULT_REMINDER_MINUTES=30
```

## 4. 上传与部署

将项目文件上传或推送到私有仓库 `liangke91-art/universal-caldav-calendar`。仓库连接到 Worker 后，推送到 `main` 会触发 Cloudflare 构建。

如果在本机部署，安装 Node.js 24+ 后在项目目录运行：

```powershell
npm install
npm run check
npm run deploy
```

Windows 可在 secrets 配置完成后双击 `deploy.cmd`。验证：

```text
https://universal-caldav-calendar.liangke91.workers.dev/healthz
```

应返回包含 `"ok": true` 的 JSON。

## 5. 测试远程 MCP 与 GitHub 登录

启动 MCP Inspector：

```powershell
npx @modelcontextprotocol/inspector@latest
```

连接：

```text
https://universal-caldav-calendar.liangke91.workers.dev/mcp
```

浏览器会先显示 Universal Calendar 授权页，再进入 GitHub。GitHub 授权页不应出现仓库权限。登录后至少测试：

1. `calendar_account_status` 返回尚未连接；
2. `calendar_create_setup_link` 返回 10 分钟有效的一次性 URL；
3. 打开 URL，自行填写 fruux/CalDAV 设备凭据；
4. 再次调用状态和列出日历；
5. 在测试日历完成新建、查询、修改、删除与重复日程；
6. 验证 `confirm=false` 无法删除。

## 6. 连接 fruux

在 fruux 的 Devices 页面为远程插件生成一组设备专用凭据。在插件的一次性安全设置页填写：

```text
Server: https://dav.fruux.com/
Username: fruux 显示的设备用户名
Password: fruux 显示的设备密码
Timezone: Asia/Shanghai
```

建议为 HarmonyOS 手机再生成另一组设备凭据，便于以后单独撤销。不要把这两组密码发到聊天中。

## 7. 接入 ChatGPT / Codex

按 OpenAI 当前官方流程：

1. 在 ChatGPT 打开 `设置 → Security and login → Developer mode`；
2. 打开 Plugins 页面并添加 MCP connection；
3. URL 填 `https://universal-caldav-calendar.liangke91.workers.dev/mcp`；
4. 完成 GitHub OAuth，检查发现的工具、schema 和写操作注解；
5. 复制 connection technical ID（通常以 `plugin_asdk_app...` 开头）。

如果要把连接包装成本项目的 Codex 插件，在项目目录运行：

```powershell
.\scripts\finalize-plugin.ps1 -AppId "plugin_asdk_app_你的ID"
```

脚本生成的 `.app.json` 已被 `.gitignore` 排除。开发者模式连接或已安装的账号级插件在不同电脑上的可用性由同一 ChatGPT/Codex 账号与工作区政策决定；远程 Worker 不需要在其他电脑重复安装服务。

## 8. 接入 HarmonyOS

HarmonyOS 6.0/6.1 常见路径：

```text
日历 → 左上角三横 → 添加 → 导入日程 → 添加 CalDAV 日历
```

填写 fruux 的 HTTPS 地址和为手机生成的设备专用用户名、密码。若当前机型或系统没有该入口，先升级系统与华为日历；仍无入口时，需要使用系统可用的 CalDAV 同步客户端。

## 9. 验收清单

- 任意电脑都只访问同一个 `/mcp` 地址；
- GitHub 登录只允许 `liangke91-art`；
- GitHub OAuth 不显示仓库权限；
- CalDAV 密码不出现在 Git、聊天或工具结果中；
- Codex 新建、修改、删除的测试日程能在 fruux 与 HarmonyOS 出现；
- 手机新建的测试日程能被 `calendar_get_events` 查询到；
- 完成后删除测试日程。
