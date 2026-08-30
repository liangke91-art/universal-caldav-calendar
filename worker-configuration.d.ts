interface Env {
  OAUTH_KV: KVNamespace;
  CALENDAR_KV: KVNamespace;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  CREDENTIALS_MASTER_KEY: string;
  PUBLIC_BASE_URL: string;
  DEFAULT_TIMEZONE: string;
  DEFAULT_REMINDER_MINUTES: string;
  ALLOWED_GITHUB_LOGINS: string;
}
