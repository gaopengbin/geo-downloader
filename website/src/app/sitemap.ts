import { MetadataRoute } from "next";
import { getStableReleases } from "@/lib/github-releases";
import { MAP_CREATION_VISIBLE, SITE_URL } from "@/lib/site";
import { localePath } from "@/lib/i18n";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [latestRelease] = await getStableReleases(1);
  const releaseDate = new Date(latestRelease.published_at);
  const pages = [
    { path: "/", date: new Date("2026-10-08"), priority: 1 },
    { path: "/agent", date: new Date("2026-10-08"), priority: 0.9 },
    { path: "/history", date: releaseDate, priority: 0.8 },
    { path: "/cli", date: new Date("2026-09-23"), priority: 0.9 },
    { path: "/mcp", date: new Date("2026-09-23"), priority: 0.9 },
    { path: "/browser", date: new Date("2026-09-24"), priority: 0.9 },
    { path: "/tools", date: new Date("2026-10-08"), priority: 0.7 },
    { path: "/disclaimer", date: new Date("2026-08-11"), priority: 0.5 },
  ];
  const localized: MetadataRoute.Sitemap = pages.flatMap(page => (["zh", "en"] as const).map(locale => ({
    url: SITE_URL + localePath(page.path, locale),
    lastModified: page.date,
    changeFrequency: page.path === "/disclaimer" ? "yearly" as const : "weekly" as const,
    priority: page.priority,
    alternates: { languages: { "zh-CN": SITE_URL + page.path, en: SITE_URL + localePath(page.path, "en") } },
  })));
  if (MAP_CREATION_VISIBLE) localized.push({ url: SITE_URL + "/geod", lastModified: new Date("2026-10-06"), changeFrequency: "monthly", priority: 0.9 });
  return localized;
}
