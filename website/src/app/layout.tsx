import type { Metadata } from "next";
import "./globals.css";
import { DEFAULT_OG_IMAGE, SITE_URL, SITE_URL_OBJECT } from "@/lib/site";

export const metadata: Metadata = {
  applicationName: "GeoD",
  title: {
    default: "GeoD - GIS 桌面数据工作台",
    template: "%s | GeoD",
  },
  metadataBase: SITE_URL_OBJECT,
  description:
    "GeoD 是一款面向 GIS 场景的桌面客户端，支持 GeoTIFF、DEM、3D Tiles、矢量与时序影像下载。",
  keywords: "GeoD,GeoDownloader,GIS,遥感,GeoTIFF,DEM,3D Tiles,矢量数据",
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "GeoD",
    title: "GeoD - GIS 桌面数据工作台",
    description:
      "面向 GIS 工作流的开源桌面工具，支持 GeoTIFF、DEM、3D Tiles、MVT 与历史影像任务。",
    images: [DEFAULT_OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: "GeoD - GIS 桌面数据工作台",
    description: "面向 GIS 工作流的开源桌面数据工具。",
    images: [DEFAULT_OG_IMAGE],
  },
  icons: {
    icon: "/geod/icon.png",
    shortcut: "/geod/favicon.ico",
    apple: "/geod/icon.png",
  },
  manifest: "/manifest.webmanifest",
  authors: [{ name: "gaopengbin", url: "https://github.com/gaopengbin" }],
  creator: "gaopengbin",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta name="msapplication-TileColor" content="#2563eb" />
        <meta name="theme-color" content="#2563eb" />
      </head>
      <body suppressHydrationWarning>
        <div className="min-h-screen">{children}</div>
      </body>
    </html>
  );
}
