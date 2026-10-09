import { LocalizedContent } from "@/app/_components/LocaleProvider";
import { type Locale } from "@/lib/i18n";
import StructuredData from "@/app/_components/StructuredData";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, FileCheck2, Gift, Github, MessageSquare, Monitor, ShieldCheck } from "lucide-react";
import SpacePage from "../_components/SpacePage";
import Header from "../_components/Header";
import Footer from "../_components/Footer";
import CTALink from "../_components/CTALink";
import { AGENT_DOWNLOAD_URL, AGENT_GITHUB_DOWNLOAD_URL } from "@/lib/agent-release";
import AgentGallery from "./AgentGallery";
import { DataFeatures, InputFeatures, TaskFeatures, ExtensionFeatures, DeliveryFeatures, ScenarioFeatures, RoadmapFeatures } from "./AgentFeatures";
import "../home.css";
import styles from "./agent.module.css";

export const metadata: Metadata = {
  title: "GeoD Agent｜用对话下载地理数据",
  description: "GeoD Agent：用对话规划和下载影像、DEM、历史影像、矢量与三维数据。在本机执行，核对坐标系，查看任务进度，带走可核验的成果。",
  keywords: "GeoD Agent,AI GIS,影像下载,历史影像,DEM,矢量数据,3D Tiles,GeoTIFF,坐标系转换,MCP,定时任务",
  alternates: { canonical: "/agent" },
  openGraph: {
    title: "GeoD Agent｜用对话完成地理数据任务",
    description: "对话、地图与成果，在一个工作区中。Windows 公开测试版 0.2.3 可下载，0.2.4 正在准备。",
    url: "/agent",
    images: [{ url: "/geod-site/agent/demo-poster-20261008-v6.jpg", width: 1920, height: 1080, alt: "GeoD Agent 对话与地图工作区" }],
  },
  twitter: { card: "summary_large_image", images: ["/geod-site/agent/demo-poster-20261008-v6.jpg"] },
};

const steps = [
  { title: "描述你要什么", text: "说出地区、数据类型和用途，也可以附上已有的范围文件。", Icon: MessageSquare },
  { title: "核对任务计划", text: "检查图源、范围、精度、格式和保存位置，再确认执行。", Icon: ShieldCheck },
  { title: "由本机完成任务", text: "下载、拼接和裁剪在你的电脑进行，进度与任务状态随时可查。", Icon: Monitor },
  { title: "带走可核验的成果", text: "在地图中查看结果，读取成果文件和校验清单，继续后续工作。", Icon: FileCheck2 },
];

const sections = [
  { href: "#demo", label: "观看演示" },
  { href: "#workspace", label: "工作区预览" },
  { href: "#data", label: "数据能力" },
  { href: "#inputs", label: "范围与图源" },
  { href: "#tasks", label: "任务管理" },
  { href: "#extensions", label: "技能与连接器" },
  { href: "#delivery", label: "成果交付" },
];

const gisSkills = [
  ["多格式范围导入", "读取边界与坐标系"],
  ["矢量转换", "格式转换与重投影"],
  ["矢量分析", "裁剪、缓冲与几何简化"],
  ["栅格检查", "检查波段、范围与统计"],
  ["栅格转换", "重投影、压缩与金字塔"],
];

export default function AgentPage({ locale = "zh" }: { locale?: Locale }) {
  return (
    <LocalizedContent><SpacePage>
      <StructuredData kind="agent" locale={locale} />
      <Header appearance="space" />
      <main className={styles.page}>
        <section className={styles.hero} aria-labelledby="agent-title">
          <a className={styles.welcomeBanner} href="#trial"><Gift size={19} aria-hidden="true" /><strong>新用户赠送 20,000 Credits 体验额度</strong><span>限量 100 名</span><ArrowRight size={16} aria-hidden="true" /></a>
          <div className={styles.heroTopline}>
            <span className={styles.eyebrow}>GEOD AGENT</span>
            <span className={styles.badge}>Windows 桌面应用 · 公开测试版</span>
          </div>
          <h1 id="agent-title">说出需求，<br />把地理数据带回工作区。</h1>
          <p className={styles.lead}>影像、DEM、历史影像、矢量与三维数据，从一次对话开始。<br className={styles.desktopBreak} />核对计划，在自己的电脑上完成下载、处理与成果核验。</p>
          <div className={styles.actions}>
            <CTALink href={AGENT_DOWNLOAD_URL}>官网下载 Windows 测试版 <ArrowRight size={17} aria-hidden="true" /></CTALink>
            <CTALink href={AGENT_GITHUB_DOWNLOAD_URL} variant="secondary" className={styles.secondaryAction}>GitHub 下载 <ArrowUpRight size={16} aria-hidden="true" /></CTALink>
            <CTALink href="#demo" variant="secondary" className={styles.secondaryAction}>观看演示</CTALink>
            <a className={styles.textLink} href="https://github.com/gaopengbin/geod-agent" target="_blank" rel="noopener noreferrer"><Github size={17} aria-hidden="true" />查看开源代码</a>
          </div>
          <p className={styles.releaseNote}>当前可下载 0.2.3 测试版 · Windows x64<a href="#candidate">查看 0.2.4 本次改进 <ArrowRight size={13} aria-hidden="true" /></a></p>
          <p className={styles.releaseNote}>安装包约 487 MB；官网下载较慢时，可切换 GitHub 线路。</p>
          <div className={styles.promiseRow}>
            {["任务执行在本机", "图源与范围可核对", "成果文件可带走"].map((text) => <span key={text}><Check size={15} aria-hidden="true" />{text}</span>)}
          </div>
          <nav className={styles.sectionNav} aria-label="Agent 功能导览">{sections.map(item => <a key={item.href} href={item.href}>{item.label}</a>)}</nav>
          <div className={styles.overviewFacts} aria-label="本机已实现的能力概览">
            <a href="#data"><strong>5</strong><span>类数据工作流</span></a>
            <a href="#inputs"><strong>13</strong><span>种范围输入方式</span></a>
            <a href="#imagery"><strong>6</strong><span>种影像输出</span></a>
            <a href="#workspace"><strong>2D / 3D</strong><span>地图与场景联动</span></a>
          </div>
        </section>

        <section id="trial" className={styles.trial} aria-labelledby="trial-title">
          <div><span className={styles.eyebrow}>新用户体验礼</span><h2 id="trial-title">先领 20,000 Credits，试试你的第一个任务。</h2><p>首次使用 GeoD Agent 的用户，登录后自动获得托管模型体验额度。限前 100 个符合条件的账号，每个 GeoD 账号仅赠送一次，名额用完即止。</p></div>
          <div className={styles.trialAction}><CTALink href={AGENT_DOWNLOAD_URL}>下载 Agent，领取体验额度 <ArrowRight size={16} aria-hidden="true" /></CTALink><a className={styles.textLink} href={AGENT_GITHUB_DOWNLOAD_URL}>GitHub 下载 <ArrowUpRight size={14} aria-hidden="true" /></a><small>已有余额记录的账号不参与新用户赠送。</small></div>
        </section>

        <section id="demo" className={styles.demo} aria-labelledby="demo-title">
          <div className={styles.demoHeading}><div><span className={styles.eyebrow}>真实操作演示 · 3 分 52 秒</span><h2 id="demo-title">配置、下载、查看成果，用对话完成。</h2></div><p>从空白会话开始，演示图源配置、MCP 接入、参数确认、影像下载和定时任务。</p></div>
          <video className={styles.demoVideo} controls playsInline preload="none" poster="/geod-site/agent/demo-poster-20261008-v6.jpg" aria-label="GeoD Agent 完整操作演示（中文配音与字幕）">
            <source src="/geod-site/agent/geod-agent-demo-20261008-v6.mp4" type="video/mp4" />
            <a href="/geod-site/agent/geod-agent-demo-20261008-v6.mp4">打开演示视频</a>
          </video>
          <div className={styles.demoCaption}><span>中文配音与字幕 · 思考与等待加速呈现 · 当前开发版实录</span><a href="/geod-site/agent/geod-agent-demo-20261008-v6.mp4" download>下载视频 <ArrowUpRight size={14} aria-hidden="true" /></a></div>
        </section>

        <section id="workspace" className={styles.workspace} aria-labelledby="workspace-title">
          <div className={styles.workspaceBar}><span>GeoD Agent / 工作区预览</span><span className={styles.previewTag}>切换截图，了解不同功能</span></div>
          <AgentGallery />
          <div className={styles.workspaceCaption}>
            <div><h2 id="workspace-title">对话、地图、成果，在同一个地方。</h2><p>围绕一个数据任务展开工作，计划与进度随时可查。</p></div>
            <span>截图标注了演示任务或真实验证，功能以对应版本为准。</span>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="workflow-title">
          <span className={styles.eyebrow}>从需求到交付</span>
          <h2 id="workflow-title">让每一步，都有据可查。</h2>
          <p className={styles.sectionLead}>AI 帮你组织任务；图源、范围和输出由你核对，任务状态与成果文件记录执行结果。</p>
          <ol className={styles.steps}>
            {steps.map(({ title, text, Icon }, index) => <li key={title}><div className={styles.stepTop}><Icon size={23} strokeWidth={1.6} aria-hidden="true" /><span>0{index + 1}</span></div><h3>{title}</h3><p>{text}</p></li>)}
          </ol>
        </section>


        <section id="candidate" className={styles.candidate} aria-labelledby="candidate-title">
          <div className={styles.candidateHeading}><div><span className={styles.eyebrow}>0.2.4 · 本地候选</span><h2 id="candidate-title">重要选择，留给你。<br />繁琐步骤，交给工具。</h2></div><p>这一版重点打磨下载过程：参数不明确先问，确认过的选择保留，缺少技能时引导安装。当前尚未发布。</p></div>
          <div className={styles.highlightGrid}>
            <article><div className={styles.highlightText}><span className={styles.badge}>需求确认</span><h3>坐标系和历史时期，先选清楚。</h3><p>未明确的参数用选项卡询问。卡片留在会话中，可稍后打开；只改缩放等级时沿用已确认坐标系。</p></div><a className={styles.choiceScreenshot} href="/geod-site/agent/coordinate-choice.png" target="_blank" rel="noopener noreferrer" aria-label="查看完整的坐标系选择卡片"><img src="/geod-site/agent/coordinate-choice.png" width={620} height={760} alt="导出坐标系选择卡片，可选择 WGS84、Web 墨卡托、CGCS2000 或自定义坐标系" loading="lazy" /></a></article>
            <article><div className={styles.highlightText}><span className={styles.badge}>按需安装</span><h3>需要哪项 GIS 能力，就安装哪项。</h3><p>五项 GIS 技能可独立安装，共享已下载依赖。主安装包移除 Java 与本地 OCR；需要时再补充处理能力。</p></div><ul className={styles.skillList}>{gisSkills.map(([name, purpose]) => <li key={name}><Check size={18} aria-hidden="true" /><div><strong>{name}</strong><span>{purpose}</span></div></li>)}</ul><a className={styles.skillScreenshotLink} href="/geod-site/agent/gis-skills-light-20261008.png" target="_blank" rel="noopener noreferrer">查看技能界面截图 <ArrowUpRight size={15} aria-hidden="true" /></a></article>
          </div>
          <div className={styles.candidateFooter}><span><Check size={16} aria-hidden="true" />下载、拼接、裁剪分别显示状态</span><span><Check size={16} aria-hidden="true" />一键打开成果目录</span><span><Check size={16} aria-hidden="true" />大段坐标通过文件引用传递</span></div>
          <p className={styles.finePrint}>界面来自真实组件验证；截图中的选择与安装状态用于展示交互。0.2.4 安装包和干净 Windows 验收仍待完成。</p>
        </section>

        <DataFeatures />
        <InputFeatures />
        <TaskFeatures />
        <ExtensionFeatures />
        <DeliveryFeatures />
        <ScenarioFeatures />

        <section className={styles.example} aria-labelledby="example-title">
          <div className={styles.exampleCopy}>
            <span className={styles.eyebrow}>一次真实下载交付</span>
            <h2 id="example-title">从范围确认，<br />走到文件交付。</h2>
            <p className={styles.prompt}>“下载昌平最新的影像。”</p>
            <p>本机已完成昌平区 704 张瓦片下载、行政边界裁剪与 GeoTIFF 输出。打开地图核对覆盖范围，在任务区查看完成状态、实际文件大小和成果目录。</p>
            <div className={styles.exampleFacts}><span><strong>704</strong>张实际瓦片</span><span><strong>158.9 MB</strong>实际成果</span></div>
            <p className={styles.finePrint}>成果下载于 2026-10-06 · 当前浅色开发版截图<br />Esri World Imagery · Z14 · EPSG:3857 · 8192 × 5632 像素。截图中的文件大小和完成状态均来自实际任务。</p>
          </div>
          <figure><a href="/geod-site/agent/imagery-light-20261008.png" target="_blank" rel="noopener noreferrer" aria-label="查看完整的昌平区影像成果截图"><img src="/geod-site/agent/imagery-light-20261008.png" width={1440} height={900} alt="当前浅色开发版：昌平区影像按边界裁剪并加载到地图，任务面板展示真实完成状态和成果大小" loading="lazy" /></a><figcaption>当前开发版实拍 · 昌平区本机成果与地图 <ArrowUpRight size={14} aria-hidden="true" /></figcaption></figure>
        </section>

        <section className={styles.boundaries} aria-labelledby="boundaries-title">
          <div><ShieldCheck size={28} strokeWidth={1.6} aria-hidden="true" /><h2 id="boundaries-title">数据在哪里执行，<br />你就在哪里掌握成果。</h2></div>
          <div><p>模型服务负责理解需求和组织工具调用。瓦片下载、拼接、裁剪与文件核验由本机完成，影像瓦片不经 GeoD 模型服务器中转。</p><p>AI 请求会将任务描述及必要的工具信息发送给模型服务。数据源仍需你拥有相应访问和下载授权；连接成功不等于获得数据许可。</p></div>
        </section>

        <RoadmapFeatures />

        <section id="updates" className={styles.updates} aria-labelledby="updates-title">
          <div className={styles.updateCopy}>
            <span className={styles.badge}>Windows x64 · 0.2.3 公开测试版</span>
            <h2 id="updates-title">下一次数据任务，<br />从一次对话开始。</h2>
            <p>先体验当前测试版，用你的实际工作流给我们反馈。关注公众号或加入技术交流群，获取版本更新与使用教程。</p>
            <p className={styles.finePrint}>0.2.4 尚未发布，本页已明确标注本地候选改进。测试版不代表全部图源、规模或外部服务已经验收。</p>
            <div className={styles.actions}><CTALink href={AGENT_DOWNLOAD_URL}>官网下载 Windows 测试版 <ArrowRight size={16} aria-hidden="true" /></CTALink><CTALink href={AGENT_GITHUB_DOWNLOAD_URL} variant="secondary" className={styles.secondaryAction}>GitHub 下载 <ArrowUpRight size={16} aria-hidden="true" /></CTALink><Link className={styles.textLink} href="/mcp">已有 Agent？查看 MCP 接入 <ArrowRight size={16} aria-hidden="true" /></Link></div>
          </div>
          <div className={styles.qrGrid}>
            <figure><img src="https://laogao.xyz/packages/qr-assets/gzh.jpg" width={160} height={160} alt="GeoD 微信公众号二维码" loading="lazy" /><figcaption>关注公众号<span>版本进展与使用教程</span></figcaption></figure>
            <figure><img src="https://laogao.xyz/packages/qr-assets/wxq_sq.png" width={160} height={160} alt="GeoD 技术交流群二维码" loading="lazy" /><figcaption>加入技术交流群<span>交流需求与反馈</span></figcaption></figure>
            <p>二维码失效可添加微信 <strong>gpb230314</strong>，备注 GeoD Agent。</p>
          </div>
        </section>

        <div className={styles.related}><p><strong>GeoD Agent</strong> 是独立桌面产品；<Link href="/mcp">GeoD MCP</Link> 是供其他 Agent 调用的工具接入方式，两者的安装与使用入口不同。</p><Link href="/">返回 GeoD 官网 <ArrowRight size={15} aria-hidden="true" /></Link></div>
      </main>
      <Footer appearance="space" />
    </SpacePage></LocalizedContent>
  );
}
