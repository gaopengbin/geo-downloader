import { MetadataRoute } from "next";
import { getStableReleases } from "@/lib/github-releases";
import { SITE_URL } from "@/lib/site";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [latestRelease] = await getStableReleases(1);
  const releaseDate = new Date(latestRelease.published_at);

  return [
    {
      url: SITE_URL,
      lastModified: releaseDate,
      changeFrequency: "weekly" as const,
      priority: 1.0,
    },
    {
      url: `${SITE_URL}/history`,
      lastModified: releaseDate,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/disclaimer`,
      lastModified: new Date("2026-08-11"),
      changeFrequency: "yearly" as const,
      priority: 0.5,
    },
  ];
}
