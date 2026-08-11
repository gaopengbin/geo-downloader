import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "GeoD - GIS 桌面数据工作台",
    short_name: "GeoD",
    description: "面向 GIS 工作流的开源桌面数据工具。",
    start_url: "/",
    display: "standalone",
    background_color: "#071127",
    theme_color: "#2563eb",
    icons: [
      {
        src: "/geod/icon.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
