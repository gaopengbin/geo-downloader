export const applicationProducts = ["desktop", "browser", "cli", "mcp", "studio", "agent"] as const;
export type ApplicationProduct = typeof applicationProducts[number];
export const productLabels: Record<ApplicationProduct, string> = { desktop: "桌面端", browser: "浏览器影像", cli: "CLI", mcp: "MCP", studio: "地图创作", agent: "GeoD Agent" };
export const applicationStatuses = ["new", "reviewing", "contacted", "invited", "closed"] as const;
export type ApplicationStatus = typeof applicationStatuses[number];
export const statusLabels: Record<ApplicationStatus, string> = { new: "待处理", reviewing: "审核中", contacted: "已联系", invited: "已发邀请", closed: "已结束" };
export const notificationLabels: Record<string, string> = { pending: "等待通知", sending: "发送中", accepted: "邮件服务已受理", failed: "通知失败", unknown: "发送结果待核对", unconfigured: "通知尚未配置" };
export interface ApplicationRecord {
  id: string; products: ApplicationProduct[]; email: string; name: string; useCase: string;
  sourcePath: string; referrerHost: string; source: string; medium: string; campaign: string;
  createdAt: string; updatedAt: string; status: ApplicationStatus; version: number; note: string;
  notification: string; notificationMessageId?: string; notificationRequestId?: string;
  history: { at: string; status: ApplicationStatus; note: string; actorId: string }[];
}
export class ApplicationRequestError extends Error { constructor(public code: string, message: string) { super(message); } }
export async function applicationRequest<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(`/api/geod-applications${path}`, { method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let value; try { value = await response.json(); } catch { throw new Error("invalid response"); }
    if (!response.ok) throw new ApplicationRequestError(value.error?.code || "APPLICATION_UNAVAILABLE", value.error?.message || "申请服务暂不可用，请稍后再试。");
    return value as T;
  } catch (error) {
    if (error instanceof ApplicationRequestError) throw error;
    throw new ApplicationRequestError("NETWORK", "连接未完成。你的填写内容已保留，请稍后重试。");
  } finally { window.clearTimeout(timer); }
}
export function applicationAttempt() {
  try { const existing = sessionStorage.getItem("geod-application-attempt"); if (existing) return existing; const id = crypto.randomUUID(); sessionStorage.setItem("geod-application-attempt", id); return id; }
  catch { return crypto.randomUUID(); }
}
export function applicationEvent(event: "opened" | "started" | "submitted" | "failed" | "entry_clicked", products: ApplicationProduct[], sourcePath: string, reason?: string, attemptId?: string) {
  if (navigator.doNotTrack === "1" || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) return;
  void applicationRequest("/events", { eventId: crypto.randomUUID(), attemptId: attemptId || applicationAttempt(), event, products, sourcePath, ...(reason ? { reason } : {}) }).catch(() => {});
}
export function applicationSource() {
  const query = new URLSearchParams(window.location.search);
  const from = query.get("from") || "/apply";
  const sourcePath = /^\/[a-zA-Z0-9_/-]*$/.test(from) && from.length <= 256 ? from : "/apply";
  let referrerHost = ""; try { referrerHost = new URL(document.referrer).hostname; } catch {}
  const channel = (key: string, max: number) => { const value = query.get(key) || ""; return /^[a-zA-Z0-9._-]+$/.test(value) && value.length <= max ? value : ""; };
  return { sourcePath, referrerHost, source: channel("utm_source", 64) || "website", medium: channel("utm_medium", 64), campaign: channel("utm_campaign", 96) };
}
