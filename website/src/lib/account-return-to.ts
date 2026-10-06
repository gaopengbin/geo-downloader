const destinations = new Set(["/", "/dashboard", "/browser", "/cli", "/mcp", "/geod", "/geod/workspace", "/geod/cli", "/admin/applications", "/api/geod/oauth/authorize"]);
export function safeAccountDestination(search: string, origin: string): string {
  const candidate = new URLSearchParams(search).get("returnTo") || "/dashboard";
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) return "/dashboard";
  try {
    const target = new URL(candidate, origin);
    if (target.origin !== origin || !destinations.has(target.pathname)) return "/dashboard";
    return target.pathname + target.search + target.hash;
  } catch { return "/dashboard"; }
}
