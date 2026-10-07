"use client";
import { LocalizedContent } from "@/app/_components/LocaleProvider";

import type { KeyboardEvent } from "react";
import { ArrowUpRight } from "lucide-react";
import { Tabs } from "../_components/Tabs";
import styles from "./agent.module.css";

const screens = [
  { id: "workbench", label: "对话工作区", image: "workbench-light-20261008.png", width: 1440, height: 900, title: "对话、地图和任务，同步展开。", text: "左侧管理工作区与会话，中间组织任务，地图查看范围，右侧核对计划、进度和成果。", note: "当前开发版 · 本机真实任务 · 浅色界面" },
  { id: "imagery-result", label: "影像成果", image: "imagery-light-20261008.png", width: 1440, height: 900, title: "下载完成，让成果回到地图。", text: "昌平区影像已按行政边界裁剪，并加载到地图。成果区记录实际文件大小，区分下载进度与最终交付。", note: "当前开发版 · 昌平区实际成果 · 704 张瓦片" },
  { id: "scene", label: "三维场景", image: "scene-light-20261008.png", width: 1440, height: 900, title: "用对话切换二维与三维。", text: "打开本机已下载的 3D Tiles，在同一工作区切换二维与三维，调整相机、管理图层和定位成果。", note: "当前开发版 · 已下载的 Cesium 官方 3D Tiles 样例" },
  { id: "sources", label: "图源管理", image: "sources-light-20261008.png", width: 1440, height: 900, title: "先看图源，再安排下载。", text: "查看图源缩略图、等级与配置，管理自己的服务连接。需要 Key 或 Token 的图源由你在本机填写。", note: "当前开发版 · 已配置图源与实际缩略图" },
  { id: "ranges", label: "范围书签", image: "ranges-light-20261008.png", width: 1440, height: 900, title: "在地图上画好，交给对话使用。", text: "绘制矩形或多边形，拖动顶点调整，命名并保存书签。已保存范围可以直接作为后续任务的输入。", note: "当前开发版 · 实际下载范围与地图" },
  { id: "schedules", label: "定时任务", image: "schedules-light-20261008.png", width: 1440, height: 900, title: "把重复下载留在任务区。", text: "在独立页面创建 AI 定时执行或定时下载，查看记录、暂停未来触发或取消本次运行。本机后台运行时可继续执行。", note: "当前开发版 · 定时任务设置界面" },
    { id: "connectors", label: "技能与连接器", image: "connectors-light-20261008.png", width: 1440, height: 900, title: "把已有工具接到同一个工作区。", text: "管理 Skill 与 MCP；连接 PostgreSQL / PostGIS、GDAL 和地图工具，让 Agent 基于真实工具结果继续工作。", note: "当前开发版 · 本机已配置的 Skill 与 MCP" },
];

export default function AgentGallery() {
  function handleTabKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!(event.target instanceof HTMLElement)) return;
    const tab = event.target.closest<HTMLButtonElement>('[role="tab"]');
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(tab.closest('[role="tablist"]')!.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const index = tabs.indexOf(tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[next].focus();
    tabs[next].click();
  }

  return <LocalizedContent><div className={styles.gallery} onKeyDown={handleTabKeys}>
    <Tabs tabs={screens.map((screen, index) => ({
      id: screen.id,
      label: screen.label,
      content: <section role="tabpanel" aria-label={screen.label}>
        <a className={styles.galleryImageLink} href={`/geod-site/agent/${screen.image}`} target="_blank" rel="noopener noreferrer" aria-label={`查看完整截图：${screen.label}`}>
          <img src={`/geod-site/agent/${screen.image}`} alt={`${screen.title} ${screen.note}`} width={screen.width} height={screen.height} loading={index === 0 ? "eager" : "lazy"} fetchPriority={index === 0 ? "high" : "auto"} />
          <span className={styles.imageExpand}><ArrowUpRight size={15} aria-hidden="true" />查看完整截图</span>
        </a>
        <div className={styles.galleryCaption}><div><h3>{screen.title}</h3><p>{screen.text}</p></div><span>{screen.note}</span></div>
      </section>,
    }))} />
  </div></LocalizedContent>;
}
