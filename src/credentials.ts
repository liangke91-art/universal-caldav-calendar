import { decryptJson, encryptJson, randomToken, type EncryptedValue } from "./crypto";

export type CalendarCredentials = {
  serverUrl: string;
  username: string;
  password: string;
  defaultCalendar?: string;
  timezone: string;
  defaultReminderMinutes?: number;
};

type SetupSession = {
  userId: string;
  accountLabel: string;
};

const PRIVATE_IPV4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export function validateCalDavUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("CalDAV server address is not a valid URL.");
  }
  if (parsed.protocol !== "https:") throw new Error("CalDAV server must use HTTPS.");
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateIpv6 =
    hostname === "::" ||
    hostname === "::1" ||
    /^f[cd][0-9a-f]{2}:/i.test(hostname) ||
    /^fe[89ab][0-9a-f]:/i.test(hostname) ||
    /^::ffff:(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(hostname);
  if (
    hostname === "localhost" ||
    privateIpv6 ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal" ||
    hostname === "169.254.169.254" ||
    PRIVATE_IPV4.some((pattern) => pattern.test(hostname))
  ) {
    throw new Error("Private, loopback, link-local, and metadata addresses are not allowed.");
  }
  parsed.hash = "";
  return parsed.toString();
}

export async function createSetupLink(
  env: Env,
  userId: string,
  accountLabel: string,
): Promise<string> {
  const token = randomToken();
  await env.CALENDAR_KV.put(`setup:${token}`, JSON.stringify({ userId, accountLabel } satisfies SetupSession), {
    expirationTtl: 600,
  });
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/setup?token=${encodeURIComponent(token)}`;
}

export async function loadCredentials(env: Env, userId: string): Promise<CalendarCredentials | null> {
  const encrypted = await env.CALENDAR_KV.get<EncryptedValue>(`calendar:credentials:${userId}`, "json");
  if (!encrypted) return null;
  return decryptJson<CalendarCredentials>(encrypted, env.CREDENTIALS_MASTER_KEY);
}

export async function deleteCredentials(env: Env, userId: string): Promise<void> {
  await env.CALENDAR_KV.delete(`calendar:credentials:${userId}`);
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;color:#18212f}form{display:grid;gap:14px}label{display:grid;gap:6px;font-weight:600}input{font:inherit;padding:10px 12px;border:1px solid #aab4c3;border-radius:8px}button{font:inherit;padding:11px 16px;border:0;border-radius:8px;background:#1668dc;color:white;font-weight:700;cursor:pointer}.note{color:#526172;line-height:1.6}.card{padding:24px;border:1px solid #dce2ea;border-radius:14px;box-shadow:0 8px 30px #17304a12}</style></head><body><div class="card">${body}</div></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

export async function handleSetupRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    const session = await env.CALENDAR_KV.get<SetupSession>(`setup:${token}`, "json");
    if (!session) return page("链接已失效", "<h1>设置链接已失效</h1><p>请回到 Calendar 插件重新生成设置链接。</p>");
    return page(
      "连接 CalDAV",
      `<h1>连接你的 CalDAV</h1><p class="note">凭据会在浏览器与 Worker 之间通过 HTTPS 传输，并使用 AES-256-GCM 加密后保存。它们不会经过对话或模型。</p><form method="post" action="/setup"><input type="hidden" name="token" value="${htmlEscape(token)}"><label>服务器地址<input name="serverUrl" type="url" value="https://dav.fruux.com/" required></label><label>设备用户名<input name="username" autocomplete="username" required></label><label>设备密码 / App Password<input name="password" type="password" autocomplete="current-password" required></label><label>默认日历名（可留空）<input name="defaultCalendar"></label><label>时区<input name="timezone" value="${htmlEscape(env.DEFAULT_TIMEZONE || "Asia/Shanghai")}" required></label><label>默认提前提醒（分钟，留空表示不添加）<input name="defaultReminderMinutes" type="number" min="0" value="${htmlEscape(env.DEFAULT_REMINDER_MINUTES || "30")}"></label><button type="submit">加密保存并连接</button></form>`,
    );
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const token = String(form.get("token") ?? "");
    const session = await env.CALENDAR_KV.get<SetupSession>(`setup:${token}`, "json");
    if (!session) return page("链接已失效", "<h1>设置链接已失效</h1><p>请重新生成链接。</p>");
    try {
      const reminderText = String(form.get("defaultReminderMinutes") ?? "").trim();
      const reminder = reminderText === "" ? undefined : Number.parseInt(reminderText, 10);
      if (reminder !== undefined && (!Number.isInteger(reminder) || reminder < 0)) {
        throw new Error("默认提醒必须是非负整数。");
      }
      const credentials: CalendarCredentials = {
        serverUrl: validateCalDavUrl(String(form.get("serverUrl") ?? "")),
        username: String(form.get("username") ?? "").trim(),
        password: String(form.get("password") ?? ""),
        defaultCalendar: String(form.get("defaultCalendar") ?? "").trim() || undefined,
        timezone: String(form.get("timezone") ?? "Asia/Shanghai").trim() || "Asia/Shanghai",
        defaultReminderMinutes: reminder,
      };
      if (!credentials.username || !credentials.password) throw new Error("用户名和密码不能为空。");
      const encrypted = await encryptJson(credentials, env.CREDENTIALS_MASTER_KEY);
      await env.CALENDAR_KV.put(`calendar:credentials:${session.userId}`, JSON.stringify(encrypted));
      await env.CALENDAR_KV.delete(`setup:${token}`);
      return page("连接已保存", `<h1>连接已保存</h1><p>Universal Calendar 已为 ${htmlEscape(session.accountLabel)} 加密保存 CalDAV 配置。现在可以关闭此页面并回到 ChatGPT 或 Codex。</p>`);
    } catch (error) {
      return page("保存失败", `<h1>保存失败</h1><p>${htmlEscape(error instanceof Error ? error.message : "配置无效")}</p>`);
    }
  }
  return new Response("Method Not Allowed", { status: 405 });
}
