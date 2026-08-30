# Universal CalDAV Calendar

一个面向 ChatGPT 与 Codex 的远程 Calendar 插件。它运行在 Cloudflare Worker，不依赖某一台电脑常开；同一账号可在办公室电脑、家用电脑和笔记本上访问同一个 CalDAV 日历。

```text
ChatGPT / Codex（任意电脑）
          │ MCP OAuth 2.1
          ▼
Cloudflare Worker 远程 MCP
          │ GitHub OAuth 仅验证身份
          │ 加密读取每位用户的 CalDAV 配置
          ▼
fruux / Nextcloud / Radicale / 公网 HTTPS CalDAV
          │
          ▼
HarmonyOS 原生日历
```

## 免费轻量架构

- Cloudflare Workers Free：远程运行 MCP；个人日历调用通常远低于免费配额。
- Cloudflare KV：保存短期 OAuth state 与加密后的 CalDAV 配置。
- GitHub OAuth App：免费，只用于登录身份验证，不申请仓库权限。
- fruux Basic：可作为免费 CalDAV 服务；也兼容其他标准 CalDAV。
- 无需域名、云服务器、Cloudflare Zero Trust 或本机常驻程序。

云服务的免费额度和政策可能调整，部署前以各服务当前页面为准。

## 安全设计

- GitHub OAuth 请求不带 `repo`、`user` 或 `user:email` scope，只读取 GitHub 公共身份的数字 ID 与登录名。
- GitHub access token 只在单次回调中用于读取身份，随后丢弃，不写入 KV，也不放进 MCP token。
- 只有 `ALLOWED_GITHUB_LOGINS` 中列出的账号可完成授权。
- OAuth 使用 PKCE、一次性 state、CSRF cookie 和浏览器 state 绑定；短期状态 10 分钟后失效。
- CalDAV 用户名和密码只在一次性 HTTPS 设置页输入，不进入聊天记录或模型上下文。
- CalDAV 凭据按 GitHub 数字用户 ID 隔离，并用 AES-256-GCM 加密后保存。
- 只允许公网 `https://` CalDAV 地址；拒绝 loopback、私网、链路本地和云元数据地址。
- 删除日程与断开账户要求显式确认。
- `.env`、`.dev.vars`、`.app.json`、`.mcp.json` 和日志均被 `.gitignore` 排除。

## 日历工具

| 工具 | 作用 |
|---|---|
| `calendar_account_status` | 检查账号连接与 CalDAV 发现 |
| `calendar_create_setup_link` | 生成一次性安全配置链接 |
| `calendar_disconnect_account` | 删除云端加密凭据，不删除日历数据 |
| `calendar_list_calendars` | 列出日历 |
| `calendar_get_events` | 查询并请求展开重复日程 |
| `calendar_search_events` | 在限定时间范围搜索日程 |
| `calendar_create_event` | 新建普通、全天或重复日程 |
| `calendar_update_event` | 修改日程或整个重复系列 |
| `calendar_delete_event` | 删除日程或整个重复系列 |
| `calendar_find_free_time` | 跨日历查找空闲时间 |
| `calendar_check_conflicts` | 检查时间冲突 |

默认时区为 `Asia/Shanghai`，默认提前提醒为 30 分钟，两者都可在安全设置页修改。重复规则支持按日、周、月、年，以及间隔、次数、截止日期和星期选择。

## 已准备的云资源

- Worker：`https://universal-caldav-calendar.liangke91.workers.dev`
- MCP：`https://universal-caldav-calendar.liangke91.workers.dev/mcp`
- GitHub 私有仓库：`https://github.com/liangke91-art/universal-caldav-calendar`
- 两个 KV namespace 已写入 `wrangler.jsonc`
- GitHub 登录白名单已设为 `liangke91-art`

尚需完成：创建 GitHub OAuth App、保存两个 OAuth 值和一个随机加密主密钥、把本项目推送到私有仓库并部署、连接 fruux 与 Codex。所有涉及真实密钥和 CalDAV 密码的步骤均由账号主人在对应安全界面完成。

完整步骤见 [DEPLOY.md](./DEPLOY.md)。Windows 也可在密钥配置完成后双击 `deploy.cmd` 执行检查和发布。

## 当前限制

- 修改和删除重复事件作用于整个系列，暂不支持只改某一次实例。
- 复杂重复事件依赖 CalDAV 服务器支持标准 `calendar-data/expand`。
- 远程 Worker 只能连接公网 HTTPS CalDAV，不能访问家庭或校园内网地址。
- 开发者模式连接能否跨设备自动出现，取决于 ChatGPT/Codex 账号与工作区的插件政策；远程服务本身不依赖设备。

## 主要参考

- OpenAI 插件认证：<https://developers.openai.com/plugins/build/auth>
- Cloudflare GitHub OAuth MCP：<https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/>
- GitHub OAuth Web Flow：<https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps>
- fruux CalDAV API：<https://fruux.com/api/>
- 华为 CalDAV HTTPS 说明：<https://consumer.huawei.com/cn/support/content/zh-cn16080632/>
