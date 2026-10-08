import { LocalizedContent } from "@/app/_components/LocaleProvider";
import type { Metadata } from "next";
import { DEFAULT_OG_IMAGE } from "@/lib/site";
import SDKPage from "./sdk/SdkPage";

export const metadata: Metadata = {
  title: "GeoD · AI 地理数据助手与 GIS 下载工具",
  description:
    "GeoD 提供开源地理数据工具：GeoD Agent 用 AI 对话配置图源、MCP 与任务，在本机下载影像、DEM、历史影像、矢量与三维数据；同时提供桌面端、CLI、MCP 和浏览器入口。",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    url: "/",
    images: [DEFAULT_OG_IMAGE],
  },
};

export default function RootPage() {
  return <LocalizedContent><SDKPage /></LocalizedContent>;
}
