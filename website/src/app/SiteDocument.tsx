import type { Metadata } from "next";
import "./globals.css";
import { LocaleProvider } from "./_components/LocaleProvider";
import { type Locale } from "@/lib/i18n";
import { DEFAULT_OG_IMAGE, SITE_URL, SITE_URL_OBJECT } from "@/lib/site";
import { ProductPageView } from "@/app/_components/ProductAnalytics";
import StructuredData from "@/app/_components/StructuredData";

export const metadata: Metadata = {
  applicationName: "GeoD",
  title: {
    default: "GeoD · AI 地理数据助手与 GIS 下载工具",
    template: "%s | GeoD",
  },
  metadataBase: SITE_URL_OBJECT,
  description:
    "GeoD Agent 用 AI 对话配置图源、规划任务与接入 MCP，在本机下载和处理影像、DEM、矢量及三维数据。开源 GIS 工具，提供桌面端、CLI 与浏览器入口。",
  keywords: "GeoD,GeoD Agent,AI GIS,地理数据下载,遥感影像下载,GeoTIFF,DEM,Esri Wayback,3D Tiles,MCP,GIS",
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "GeoD",
    title: "GeoD · AI 地理数据助手与 GIS 下载工具",
    description:
      "用 AI 对话配置图源与任务，在本机下载影像、DEM、矢量和三维数据。",
    images: [DEFAULT_OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: "GeoD · AI 地理数据助手与 GIS 下载工具",
    description: "用 AI 对话配置图源与任务，在本机下载影像、DEM、矢量和三维数据。",
    images: [DEFAULT_OG_IMAGE],
  },
  icons: {
    icon: "/geod-site/logo-symbol.png",
    shortcut: "/geod-site/logo-symbol.png",
    apple: "/geod-site/logo-symbol.png",
  },
  manifest: "/manifest.webmanifest",
  authors: [{ name: "gaopengbin", url: "https://github.com/gaopengbin" }],
  creator: "gaopengbin",
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-video-preview": -1, "max-snippet": -1 } },
};

export default function RootLayout({
  children,
  locale,
}: Readonly<{
  children: React.ReactNode;
  locale: Locale;
}>) {
  return (
    <html lang={locale === "en" ? "en" : "zh-CN"} suppressHydrationWarning>
      <head>
        <meta name="msapplication-TileColor" content="#ffffff" />
        <meta name="theme-color" content="#ffffff" />
      </head>
      <body suppressHydrationWarning>
        <StructuredData kind="site" locale={locale} />
        <LocaleProvider locale={locale}>
        <ProductPageView />
        <div className="min-h-screen">{children}</div>
        </LocaleProvider>
      </body>
    </html>
  );
}
