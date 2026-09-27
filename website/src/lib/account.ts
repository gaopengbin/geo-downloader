export type GeoDAccount = {
  user: { id: string; email: string; createdAt: string; emailVerifiedAt?: string; phone?: string; phoneVerifiedAt?: string; avatar?: { kind: "preset"; id: string } | { kind: "upload"; version: string } } | null;
  authRequired: boolean;
  quota?: { remaining: number; giftRemaining?: number; purchasedRemaining?: number; unit?: string };
  storage?: { count: number; usedBytes: number; maxBytes: number };
};

export type VerificationInfo = { channels: { email: boolean; sms: boolean }; registration: string };
export type AccountSession = { id: string; createdAt: string; expiresAt: string; current: boolean };

export class AccountError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function accountErrorText(reason: unknown): string {
  const messages: Record<string, string> = {
    INVALID_EMAIL: "请输入有效的邮箱地址。",
    INVALID_PASSWORD: "当前账号服务要求密码为 12–128 个字符。",
    INVALID_CREDENTIALS: "邮箱或密码不正确，请检查后重试。",
    ACCOUNT_ALREADY_REGISTERED: "该邮箱已注册，请直接登录或找回密码。",
    ACCOUNT_NOT_FOUND: "该邮箱尚未注册，请先注册。",
    VERIFICATION_INVALID: "验证码错误、已过期或已使用，请检查后重试。",
    VERIFICATION_RATE_LIMIT: "验证码发送过于频繁，请稍后再试。",
    VERIFICATION_SEND_FAILED: "验证码发送失败，请稍后重试。",
    VERIFICATION_UNAVAILABLE: "邮箱验证暂不可用，请稍后再试。",
    LOGIN_RATE_LIMIT: "登录尝试过多，请在 15 分钟后重试。",
    AUTH_REQUIRED: "登录已失效，请重新登录。",
    ORIGIN_REJECTED: "请从 GeoD 官网重新打开此页面。",
    ACCOUNT_BUSY: "账号服务暂时繁忙，请稍后重试。",
    AVATAR_INVALID_PRESET: "请选择提供的默认头像。",
    AVATAR_UNSUPPORTED_TYPE: "请选择 JPG、PNG、WebP 或 AVIF 图片。",
    AVATAR_TOO_LARGE: "图片不能超过 5 MB。",
    AVATAR_INVALID_IMAGE: "图片无法读取，请换一张试试。",
    SOURCE_INVALID: "图源信息无效，请检查地址、级别与署名。",
    SOURCE_LIMIT: "一个账号最多保存 20 个自定义图源。",
    SOURCE_NOT_FOUND: "图源不存在，请刷新后重试。",
    SOURCE_DECRYPTION_FAILED: "账号图源暂时无法读取，请联系支持人员；不要重新保存以免覆盖。",
  };
  return reason instanceof AccountError ? messages[reason.code] ?? "账号操作未完成，请稍后重试。" : "网络连接失败，请检查网络后重试。";
}

export async function accountRequest<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 22000);
  try {
    const response = await fetch(url, {
      method, credentials: "same-origin", cache: "no-store", signal: controller.signal,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const error = value && typeof value === "object" && "error" in value ? value.error : null;
      const detail = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : null;
      throw new AccountError(typeof detail?.code === "string" ? detail.code : "ACCOUNT_UNAVAILABLE", typeof detail?.message === "string" ? detail.message : "Account request failed");
    }
    return value as T;
  } finally { window.clearTimeout(timeout); }
}

export function safeReturnTo(search: string): string {
  const candidate = new URLSearchParams(search).get("returnTo") || "/dashboard";
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) return "/dashboard";
  try {
    const target = new URL(candidate, window.location.origin);
    if (target.origin !== window.location.origin) return "/dashboard";
    if (!["/", "/dashboard", "/browser", "/cli", "/mcp", "/geod"].includes(target.pathname)) return "/dashboard";
    return target.pathname + target.search + target.hash;
  } catch { return "/dashboard"; }
}
