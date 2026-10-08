import { type Locale } from "@/lib/i18n";
import { SITE_URL, DEFAULT_OG_IMAGE } from "@/lib/site";
import { AGENT_PUBLIC_VERSION, AGENT_DOWNLOAD_URL } from "@/lib/agent-release";

export default function StructuredData({ kind, locale }: { kind: "site" | "agent"; locale: Locale }) {
  const en = locale === "en";
  const home = SITE_URL + (en ? "/en" : "/");
  const url = SITE_URL + (en ? "/en/agent" : "/agent");
  const graph = kind === "site" ? [
    { "@type": "Organization", "@id": SITE_URL + "/#organization", name: "GeoD", url: SITE_URL,
      logo: SITE_URL + "/geod-site/logo-symbol.png", sameAs: ["https://github.com/gaopengbin", "https://github.com/gaopengbin/geod-agent", "https://github.com/gaopengbin/geo-downloader"] },
    { "@type": "WebSite", "@id": home + "#website", name: "GeoD", url: home,
      inLanguage: en ? "en" : "zh-CN", publisher: { "@id": SITE_URL + "/#organization" } },
  ] : [
    { "@type": "SoftwareApplication", "@id": url + "#software", name: "GeoD Agent", url,
      applicationCategory: "DeveloperApplication", applicationSubCategory: "GIS", operatingSystem: "Windows 10, Windows 11 (x64)",
      softwareVersion: AGENT_PUBLIC_VERSION, downloadUrl: AGENT_DOWNLOAD_URL,
      license: "https://github.com/gaopengbin/geod-agent/blob/main/LICENSE",
      sameAs: "https://github.com/gaopengbin/geod-agent",
      description: en ? "Use AI conversations to configure sources, plan GIS tasks and connect MCP tools. Download, process and verify geographic data on your computer." : "通过 AI 对话配置图源、规划 GIS 任务与接入 MCP，在本机下载、处理和核验地理数据。",
      screenshot: SITE_URL + "/geod-site/agent/workbench-light-20261008.png",
      author: { "@type": "Person", name: "gaopengbin", url: "https://github.com/gaopengbin" } },
    { "@type": "VideoObject", "@id": url + "#demo", name: en ? "GeoD Agent product demo" : "GeoD Agent 完整操作演示",
      description: en ? "A real development-build recording: configure sources and MCP, confirm parameters, download imagery, inspect outputs and schedule tasks. Chinese narration and subtitles." : "当前开发版真实录制：配置图源与 MCP、确认参数、下载影像、查看成果及创建定时任务，带中文配音与字幕。",
      thumbnailUrl: [SITE_URL + DEFAULT_OG_IMAGE], uploadDate: "2026-10-08T23:12:16+08:00", duration: "PT3M52S",
      contentUrl: SITE_URL + "/geod-site/agent/geod-agent-demo-20261008-v6.mp4", inLanguage: "zh-CN", url: url + "#demo",
      publisher: { "@id": SITE_URL + "/#organization" } },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "GeoD", item: home },
      { "@type": "ListItem", position: 2, name: "GeoD Agent", item: url },
    ] },
  ];
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c") }} />;
}
