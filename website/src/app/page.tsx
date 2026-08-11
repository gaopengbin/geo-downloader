import type { Metadata } from "next";
import { DEFAULT_OG_IMAGE } from "@/lib/site";
import SDKPage from "./sdk/SdkPage";

export const metadata: Metadata = {
  title: "GeoD - 地理空间数据下载与导出工具",
  description:
    "GeoD 是一款面向 GIS 工作流的开源桌面工具，支持 2D 地图瓦片、GeoTIFF、DEM、3D Tiles 与 Esri Wayback 历史影像下载，适用于 Windows、macOS、Linux。",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    url: "/",
    images: [DEFAULT_OG_IMAGE],
  },
};

export default function RootPage() {
  return <SDKPage />;
}
