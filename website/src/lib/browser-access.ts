export const FREE_MAX_ZOOM = 5;

export async function browserAccount() {
  let response: Response;
  try { response = await fetch("/api/account", { cache: "no-store", credentials: "same-origin" }); }
  catch { throw new Error("GeoD 账号暂时无法验证，请检查网络后重试。"); }
  if (!response.ok) throw new Error("GeoD 账号暂时无法验证，请稍后重试。");
  const value: unknown = await response.json();
  return !!value && typeof value === "object" && "user" in value && !!value.user;
}

export async function requireBrowserZoomAccess(zoom: number) {
  if (zoom <= FREE_MAX_ZOOM) return;
  if (!(await browserAccount())) throw new Error("LOGIN_REQUIRED: 下载 6 级及以上影像需先登录 GeoD。请点击本页的登录入口，完成后重试。");
}
