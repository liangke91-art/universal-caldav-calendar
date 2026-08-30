import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { decryptJson, encryptJson, randomToken, safeEqual, type EncryptedValue } from "./crypto";

export type AuthProps = {
  userId: string;
  login: string;
  name: string;
};

type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };
type UpstreamState = {
  oauthRequest: AuthRequest;
  verifier: string;
  state: string;
  issuedAt: number;
};
type ConsentState = {
  oauthRequest: AuthRequest;
  issuedAt: number;
};
type GitHubTokenResponse = {
  access_token?: string;
  error?: string;
};
type GitHubUser = {
  id?: number;
  login?: string;
  name?: string | null;
};

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const STATE_COOKIE = "__Host-CALENDAR_STATE";
const OAUTH_STATE_MAX_AGE_MS = 15 * 60 * 1000;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#039;");
}

function cookie(request: Request, name: string): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function urlSafeBase64(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sealState(value: unknown, secret: string): Promise<string> {
  const encrypted = await encryptJson(value, secret);
  return `1.${urlSafeBase64(encrypted.iv)}.${urlSafeBase64(encrypted.ciphertext)}`;
}

async function openState<T>(token: string, secret: string): Promise<T | undefined> {
  const [version, iv, ciphertext, extra] = token.split(".");
  if (version !== "1" || !iv || !ciphertext || extra !== undefined) return undefined;
  try {
    return await decryptJson<T>({ version: 1, iv, ciphertext } satisfies EncryptedValue, secret);
  } catch {
    return undefined;
  }
}

function isFresh(issuedAt: number): boolean {
  return Number.isFinite(issuedAt) && issuedAt <= Date.now() + 30_000 && Date.now() - issuedAt <= OAUTH_STATE_MAX_AGE_MS;
}

async function challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function clearStateCookie(): string {
  return `${STATE_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
}

function consentPage(clientName: string, state: string): Response {
  const startUrl = `/github-start?request=${encodeURIComponent(state)}`;
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权 Universal Calendar</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:56px auto;padding:0 20px;color:#18212f}.card{border:1px solid #dce2ea;border-radius:16px;padding:28px;box-shadow:0 8px 30px #17304a12}.button{display:inline-block;text-decoration:none;border-radius:9px;padding:12px 18px;background:#1668dc;color:#fff;font-weight:700}.muted{color:#58687a;line-height:1.6}</style></head><body><div class="card"><h1>授权 Universal Calendar</h1><p><strong>${escapeHtml(clientName)}</strong> 请求访问你的日历工具。</p><p class="muted">下一步使用 GitHub 验证身份。此应用不申请仓库权限，也不会保存 GitHub access token。授权后可查询、新建、修改和删除日程；CalDAV 凭据通过独立的加密设置页录入，不进入对话。</p><a class="button" href="${escapeHtml(startUrl)}">使用 GitHub 登录并授权</a></div></body></html>`;
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function allowedGitHubLogin(env: Env, login: string): boolean {
  const allowed = env.ALLOWED_GITHUB_LOGINS.split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(login.toLowerCase());
}

async function exchangeGitHubCode(env: Env, code: string, verifier: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    client_secret: env.GITHUB_CLIENT_SECRET,
    code,
    redirect_uri: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/callback`,
    code_verifier: verifier,
  });
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "universal-caldav-calendar",
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("GitHub token exchange failed.");
  const token = (await response.json()) as GitHubTokenResponse;
  if (!token.access_token || token.error) throw new Error("GitHub did not return an access token.");
  return token.access_token;
}

async function fetchGitHubIdentity(accessToken: string): Promise<Required<Pick<GitHubUser, "id" | "login">> & GitHubUser> {
  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "universal-caldav-calendar",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("GitHub identity lookup failed.");
  const user = (await response.json()) as GitHubUser;
  if (!Number.isSafeInteger(user.id) || !user.login) throw new Error("GitHub identity response is incomplete.");
  return user as Required<Pick<GitHubUser, "id" | "login">> & GitHubUser;
}

export async function handleAuthRequest(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/authorize") {
    const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    if (!oauthRequest.clientId) return new Response("Invalid OAuth request", { status: 400 });
    const state = await sealState({ oauthRequest, issuedAt: Date.now() } satisfies ConsentState, env.CREDENTIALS_MASTER_KEY);
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    return consentPage(client?.clientName || "ChatGPT / Codex", state);
  }

  if (request.method === "GET" && url.pathname === "/github-start") {
    const state = url.searchParams.get("request") ?? "";
    const consent = await openState<ConsentState>(state, env.CREDENTIALS_MASTER_KEY);
    if (!consent?.oauthRequest.clientId || !isFresh(consent.issuedAt)) {
      return new Response("Expired OAuth request", { status: 400 });
    }

    const upstreamState = randomToken();
    const verifier = randomToken(48);
    const upstreamCookie = await sealState(
      { oauthRequest: consent.oauthRequest, verifier, state: upstreamState, issuedAt: Date.now() } satisfies UpstreamState,
      env.CREDENTIALS_MASTER_KEY,
    );
    const authorize = new URL(GITHUB_AUTHORIZE_URL);
    authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/callback`);
    authorize.searchParams.set("state", upstreamState);
    authorize.searchParams.set("code_challenge", await challenge(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    return new Response(null, {
      status: 302,
      headers: {
        location: authorize.toString(),
        "set-cookie": `${STATE_COOKIE}=${upstreamCookie}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=900`,
        "cache-control": "no-store",
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/callback") {
    const state = url.searchParams.get("state") ?? "";
    const stored = await openState<UpstreamState>(cookie(request, STATE_COOKIE) ?? "", env.CREDENTIALS_MASTER_KEY);
    if (!state || !stored || !safeEqual(state, stored.state) || !isFresh(stored.issuedAt)) {
      return new Response("Invalid OAuth state", { status: 400, headers: { "set-cookie": clearStateCookie() } });
    }
    const code = url.searchParams.get("code") ?? "";
    if (!code || url.searchParams.has("error")) {
      return new Response("GitHub authorization was not completed", { status: 400, headers: { "set-cookie": clearStateCookie() } });
    }
    try {
      const accessToken = await exchangeGitHubCode(env, code, stored.verifier);
      const user = await fetchGitHubIdentity(accessToken);
      if (!allowedGitHubLogin(env, user.login)) {
        return new Response("This GitHub account is not allowed.", { status: 403, headers: { "set-cookie": clearStateCookie() } });
      }
      const userId = `github:${user.id}`;
      const name = user.name?.trim() || user.login;
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: stored.oauthRequest,
        userId,
        scope: stored.oauthRequest.scope,
        metadata: { label: user.login },
        props: { userId, login: user.login, name } satisfies AuthProps,
      });
      return new Response(null, {
        status: 302,
        headers: { location: redirectTo, "set-cookie": clearStateCookie(), "cache-control": "no-store" },
      });
    } catch {
      return new Response("GitHub identity verification failed", { status: 403, headers: { "set-cookie": clearStateCookie() } });
    }
  }

  return new Response("Not Found", { status: 404 });
}
