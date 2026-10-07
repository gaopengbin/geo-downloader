import { LocalizedContent } from "@/app/_components/LocaleProvider";
import { ArrowRight } from "lucide-react";
import CTALink from "../_components/CTALink";
import styles from "./agent.module.css";
import { dataTypes } from "./AgentFeatures";

export default function AgentSection() {
  return (
    <LocalizedContent><section id="agent" className={styles.homeSection} aria-labelledby="home-agent-title">
      <div className={styles.homePanel}>
        <div className={styles.homeCopy}>
          <span className={styles.badge}>GEOD AGENT · 公开测试</span>
          <h2 id="home-agent-title">下一次数据任务，<br />从一次对话开始。</h2>
          <p>从影像、DEM 到矢量和三维数据，用对话组织下载与处理。文件、PostGIS 和手绘范围，都能接到你的任务里。</p>
          <div className={styles.actions}><CTALink href="/agent">了解 GeoD Agent <ArrowRight size={16} aria-hidden="true" /></CTALink></div>
          <p className={styles.releaseNote}>Windows 0.2.3 测试版可下载 · 0.2.4 本地候选准备中</p>
        </div>
        <figure className={styles.homeFigure}>
          <a href="/agent#workspace" aria-label="查看 GeoD Agent 开发版工作区"><img src="/geod-site/agent/workbench-light-20261008.png" alt="GeoD Agent 当前开发版：路线范围影像已完成，地图显示真实成果，任务区展示文件大小与坐标系" width={1440} height={900} loading="lazy" /></a>
          <figcaption>当前开发版实拍 · 本机下载成果</figcaption>
        </figure>
      </div>
      <div className={styles.homeFeatures} aria-label="GeoD Agent 数据能力">{dataTypes.map(({ id, title, Icon }) => <a href={`/agent#${id}`} key={id}><Icon size={22} strokeWidth={1.6} aria-hidden="true" /><span>{title}</span><ArrowRight size={15} aria-hidden="true" /></a>)}</div>
      <div className={styles.homeMore}><span>在同一个工作区里</span><a href="/agent#tasks">多区域与定时下载</a><a href="/agent#extensions">Skill / MCP 扩展</a><a href="/agent#delivery">本机成果核验</a></div>
    </section></LocalizedContent>
  );
}
