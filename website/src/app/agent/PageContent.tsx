import { LocalizedContent } from "@/app/_components/LocaleProvider";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, FileCheck2, MessageSquare, Monitor, ShieldCheck } from "lucide-react";
import Background from "../_components/Background";
import Header from "../_components/Header";
import Footer from "../_components/Footer";
import CTALink from "../_components/CTALink";
import { AGENT_DOWNLOAD_URL } from "@/lib/agent-release";
import AgentGallery from "./AgentGallery";
import { DataFeatures, InputFeatures, TaskFeatures, ExtensionFeatures, DeliveryFeatures, ScenarioFeatures, RoadmapFeatures } from "./AgentFeatures";
import "../home.css";
import styles from "./agent.module.css";

export const metadata: Metadata = {
  title: "GeoD Agent｜用对话下载地理数据",
  description: "GeoD Agent：用对话规划和下载影像、DEM、历史影像、矢量与三维数据。在本机执行，核对坐标系，查看任务进度，带走可核验的成果。",
  alternates: { canonical: "/agent" },
  openGraph: {
    title: "GeoD Agent｜用对话完成地理数据任务",
    description: "对话、地图与成果，在一个工作区中。Windows 公开测试版 0.2.3 可下载，0.2.4 正在准备。",
    url: "/agent",
    images: ["/geod-site/agent/workbench-light.jpg"],
  },
};

const steps = [
  { title: "描述你要什么", text: "说出地区、数据类型和用途，也可以附上已有的范围文件。", Icon: MessageSquare },
  { title: "核对任务计划", text: "检查图源、范围、精度、格式和保存位置，再确认执行。", Icon: ShieldCheck },
  { title: "由本机完成任务", text: "下载、拼接和裁剪在你的电脑进行，进度与任务状态随时可查。", Icon: Monitor },
  { title: "带走可核验的成果", text: "在地图中查看结果，读取成果文件和校验清单，继续后续工作。", Icon: FileCheck2 },
];

const sections = [
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

export default function AgentPage() {
  return (
    <LocalizedContent><>
      <Background sticky />
      <Header />
      <main className={styles.page}>
        <section className={styles.hero} aria-labelledby="agent-title">
          <div className={styles.heroTopline}>
            <span className={styles.eyebrow}>GEOD AGENT</span>
            <span className={styles.badge}>Windows 桌面应用 · 公开测试版</span>
          </div>
          <h1 id="agent-title">说出需求，<br />把地理数据带回工作区。</h1>
          <p className={styles.lead}>影像、DEM、历史影像、矢量与三维数据，从一次对话开始。<br className={styles.desktopBreak} />核对计划，在自己的电脑上完成下载、处理与成果核验。</p>
          <div className={styles.actions}>
            <CTALink href={AGENT_DOWNLOAD_URL}>下载 Windows 测试版 <ArrowRight size={17} aria-hidden="true" /></CTALink>
            <CTALink href="#workspace" variant="secondary" className={styles.secondaryAction}>看看工作区</CTALink>
          </div>
          <p className={styles.releaseNote}>当前可下载 0.2.3 测试版 · Windows x64<a href="#candidate">查看 0.2.4 本次改进 <ArrowRight size={13} aria-hidden="true" /></a></p>
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
            <article><div className={styles.highlightText}><span className={styles.badge}>按需安装</span><h3>需要哪项 GIS 能力，就安装哪项。</h3><p>五项 GIS 技能可独立安装，共享已下载依赖。主安装包移除 Java 与本地 OCR；需要时再补充处理能力。</p></div><ul className={styles.skillList}>{gisSkills.map(([name, purpose]) => <li key={name}><Check size={18} aria-hidden="true" /><div><strong>{name}</strong><span>{purpose}</span></div></li>)}</ul><a className={styles.skillScreenshotLink} href="/geod-site/agent/gis-skills.png" target="_blank" rel="noopener noreferrer">查看技能界面截图 <ArrowUpRight size={15} aria-hidden="true" /></a></article>
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
            <span className={styles.eyebrow}>一次真实开发验证</span>
            <h2 id="example-title">一句需求，<br />串起多个地区。</h2>
            <p className={styles.prompt}>“下载驻马店及周边几个市的影像。”</p>
            <p>开发版已用真实模型完成驻马店及周边六市的范围读取、合并裁剪、GeoTIFF 下载与地图加载。</p>
            <div className={styles.exampleFacts}><span><strong>7</strong>个城市范围</span><span><strong>GeoTIFF</strong>本机成果</span></div>
            <p className={styles.finePrint}>本机小规模验证 · 2026-10-02<br />20 张实际影像瓦片，Z8。说明这条流程已跑通，不代表所有图源、精度和规模均已验证。</p>
          </div>
          <figure><a href="/geod-site/agent/batch-result.jpg" target="_blank" rel="noopener noreferrer" aria-label="查看完整的多区域下载验证截图"><img src="/geod-site/agent/batch-result.jpg" width={1280} height={720} alt="本机真实验证截图：多个城市的合并范围已裁剪为影像并加载到地图，左侧为验证工具输出" loading="lazy" /></a><figcaption>真实本机成果与地图 · 左侧为开发验证工具 <ArrowUpRight size={14} aria-hidden="true" /></figcaption></figure>
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
            <div className={styles.actions}><CTALink href={AGENT_DOWNLOAD_URL}>下载 Windows 测试版 <ArrowRight size={16} aria-hidden="true" /></CTALink><Link className={styles.textLink} href="/mcp">已有 Agent？查看 MCP 接入 <ArrowRight size={16} aria-hidden="true" /></Link></div>
          </div>
          <div className={styles.qrGrid}>
            <figure><img src="https://laogao.xyz/packages/qr-assets/gzh.jpg" width={160} height={160} alt="GeoD 微信公众号二维码" loading="lazy" /><figcaption>关注公众号<span>版本进展与使用教程</span></figcaption></figure>
            <figure><img src="https://laogao.xyz/packages/qr-assets/wxq_sq.png" width={160} height={160} alt="GeoD 技术交流群二维码" loading="lazy" /><figcaption>加入技术交流群<span>交流需求与反馈</span></figcaption></figure>
            <p>二维码失效可添加微信 <strong>gpb230314</strong>，备注 GeoD Agent。</p>
          </div>
        </section>

        <div className={styles.related}><p><strong>GeoD Agent</strong> 是独立桌面产品；<Link href="/mcp">GeoD MCP</Link> 是供其他 Agent 调用的工具接入方式，两者的安装与使用入口不同。</p><Link href="/">返回 GeoD 官网 <ArrowRight size={15} aria-hidden="true" /></Link></div>
      </main>
      <Footer />
    </></LocalizedContent>
  );
}
