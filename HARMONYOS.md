# HarmonyOS 接入 fruux

CalDAV 不是可用一个链接自动导入账号的订阅格式：系统必须保存服务器、设备用户名和设备密码。因此没有安全的“一键导入链接”，也不应把密码写进链接、二维码或聊天记录。

## 已准备好的入口

- fruux 设备管理：<https://fruux.com/sync/>
- CalDAV 服务器：`https://dav.fruux.com/`
- 设备：选择已经创建的 `Huawei HarmonyOS`

请在手机浏览器登录同一个 fruux 账号，打开设备管理页查看 `Huawei HarmonyOS` 的设备专用用户名和密码。不要使用 `Universal Calendar MCP` 的那组凭据。

## 华为手机操作

HarmonyOS 6.0/6.1/7.0 的官方入口为：

```text
日历 → 左上角三横 → 添加 → 导入日程 → 添加 CalDAV 日历
```

填写：

```text
服务器：https://dav.fruux.com/
用户名：fruux 的 Huawei HarmonyOS 设备用户名
密码：fruux 的 Huawei HarmonyOS 设备密码
```

保持 HTTPS，不要改成 HTTP。保存后等待首次同步；第一次可能需要几分钟。

## 双向验收

1. 在 ChatGPT/Codex 中使用 `Universal CalDAV Calendar` 新建一个五分钟测试日程，确认手机原生日历出现。
2. 在手机的 fruux/Calendar 日历中新建另一个五分钟测试日程，确认 App 能查询到。
3. 两边都确认后删除两个测试日程。

如果手机提示认证失败，最常见原因是把 MCP 设备凭据填到了手机，或复制设备密码时带入空格。回到 fruux 的 `Huawei HarmonyOS` 设备页重新复制，不要在聊天中发送凭据。

华为官方说明：<https://consumer.huawei.com/cn/support/content/zh-cn16080632/>
