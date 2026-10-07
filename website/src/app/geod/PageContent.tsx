import type { Metadata } from "next";
import Image from "next/image";
import { ArrowUpRight, ImageIcon, Layers3, MapPin, SlidersHorizontal, Download, ShieldCheck } from "lucide-react";
import { ButtonLink } from "@/components/motion/button/base";
import { MAP_CREATION_VISIBLE, MAP_WORKSPACE_URL } from "@/lib/site";
import showcase from "@/lib/map-showcase.json";
import Background from "../_components/Background";
import Header from "../_components/Header";
import Footer from "../_components/Footer";
import ApplicationLink from "../_components/ApplicationLink";
import home from "../styles.module.css";
import styles from "./map-product.module.css";

export const metadata: Metadata = {
  title: "GeoD 地图创作｜从一句话，到一张地图",
  description: "描述地点、主题与风格，以真实地理资料为基础，预览、调整并导出地形、影像与专题地图。",
  alternates: { canonical: "/geod" },
  openGraph: { images: [{ url: showcase.hero.src, width: showcase.hero.width, height: showcase.hero.height, alt: "GeoD 尼泊尔河谷沙盘风格示例" }] },
};

const examplesUrl = "/geod/examples";
const steps = [
  { number: "01", icon: MapPin, title: "描述你的地图", description: "输入地点、主题和成图要求，选择风格，让 AI 分析需要的地图资料。" },
  { number: "02", icon: SlidersHorizontal, title: "预览并调整", description: "查看成图，补充调整要求或更换风格，在工作台保留每次生成的版本。" },
  { number: "03", icon: Download, title: "导出你的成果", description: "导出完整 PNG 成图，用于后续排版、报告与内容制作。" },
];

export default function MapProductPage() {
  return <>
    <Background sticky />
    <Header />
    <main className={`${home.home} ${styles.page}`}>
      <div className={styles.productNav}>
        <span><Layers3 size={17} aria-hidden="true" />地图创作</span>
        <nav aria-label="地图创作内容导航">
          <a href="#examples">成图示例</a><a href="#workflow">创作流程</a>
          <a href="/geod/gallery">作品广场</a>
        </nav>
      </div>

      <section className={`${home.section} ${home.heroSection} ${styles.hero}`} aria-labelledby="map-hero-title">
        <div className={home.heroCopy}>
          <span className={home.heroKicker}>GEOD / MAP CREATION</span>
          <h1 id="map-hero-title" className={home.h1}>从一句话，<br /><span className={home.heroTitle}>到一张地图。</span></h1>
          <p className={`${home.p} ${home.heroDescription}`}>描述地点、主题与风格。以真实地理资料为基础，把山川、城市和你的数据，整理成可以调整与导出的地图。</p>
          <div className={home.heroActions}>
            {MAP_CREATION_VISIBLE && <ButtonLink href={MAP_WORKSPACE_URL} target="_blank" rel="noopener noreferrer" size="lg" className={styles.heroButton}>开始创作<ArrowUpRight size={17} aria-hidden="true" /></ButtonLink>}
            <ButtonLink href="#examples" variant="secondary" size="lg" className={styles.heroButton}>查看成图示例<ImageIcon size={17} aria-hidden="true" /></ButtonLink>
          </div>
          {MAP_CREATION_VISIBLE && <p className={styles.accountNote}><ShieldCheck size={16} aria-hidden="true" />工作台在新窗口打开，复用官网的 GeoD 登录状态。</p>}
        </div>
        <figure className={`${home.heroVisual} ${styles.heroVisual}`}>
          <div className={home.heroVisualTop}><Layers3 size={15} aria-hidden="true" />GeoD 地图创作<span>示例成图</span></div>
          <a href={`${examplesUrl}/nepal-sandtable`} aria-label="查看尼泊尔河谷沙盘版完整成图"><Image src={showcase.hero.src} alt="GeoD 基于地形资料生成的尼泊尔河谷沙盘风格示例，非现场照片" width={showcase.hero.width} height={showcase.hero.height} priority unoptimized className={styles.heroImage} /></a>
          <figcaption className={styles.heroCaption}><div><strong>尼泊尔河谷 · 沙盘风格</strong><span>真实地形资料，经过风格美化的示例成图。</span></div><a href={`${examplesUrl}/nepal-sandtable`} aria-label="查看完整沙盘成图">查看成图<ArrowUpRight size={15} aria-hidden="true" /></a></figcaption>
        </figure>
      </section>

      <section id="examples" className={`${home.section} ${styles.examplesSection}`} aria-labelledby="examples-title">
        <div className={styles.sectionHeading}><div><span className={home.sectionEyebrow}>EXAMPLES / MAP RESULTS</span><h2 id="examples-title" className={`${home.h1} ${home.sectionTitle} ${styles.sectionTitle}`}>先看成图，再开始创作。</h2><p className={`${home.p} ${home.sectionLead}`}>地形、影像与专题地图，各有适合的表达方式。</p></div><ButtonLink href={examplesUrl} variant="secondary" className={styles.sectionAction}>查看全部示例<ArrowUpRight size={16} aria-hidden="true" /></ButtonLink></div>
        <div className={styles.examples}>
          {showcase.examples.map(example => <article key={example.id} className={styles.example}>
            <a className={styles.exampleLink} href={`${examplesUrl}/${example.id}`}>
              <div className={styles.exampleImage}><Image src={example.src} alt={example.title} width={example.width} height={example.height} sizes="(max-width: 680px) 100vw, (max-width: 1000px) 50vw, 33vw" unoptimized /><span>{example.category}</span></div>
              <div className={styles.exampleCopy}><h3>{example.title}</h3><p>{example.description}</p><span className={styles.cardAction}>查看完整成图<ArrowUpRight size={15} aria-hidden="true" /></span></div>
            </a>
          </article>)}
        </div>
        <p className={styles.provenanceNote}><ShieldCheck size={16} aria-hidden="true" />示例保留各自的数据来源与说明；风格试验的效果不代表已经验证地理精度。</p>
      </section>

      <section id="workflow" className={`${home.section} ${styles.workflowSection}`} aria-labelledby="workflow-title">
        <span className={home.sectionEyebrow}>WORKFLOW / CREATE & EXPORT</span>
        <h2 id="workflow-title" className={`${home.h1} ${home.sectionTitle} ${styles.sectionTitle}`}>创作、调整、导出。</h2>
        <p className={`${home.p} ${home.sectionLead}`}>把操作留在工作台，把时间留给内容。</p>
        <ol className={styles.steps}>{steps.map(step => <li key={step.number}><div className={styles.stepTop}><span>{step.number}</span><step.icon size={21} strokeWidth={1.8} aria-hidden="true" /></div><h3>{step.title}</h3><p>{step.description}</p></li>)}</ol>
      </section>

      {MAP_CREATION_VISIBLE && <section className={`${home.section} ${styles.ctaSection}`} aria-labelledby="create-title"><div className={styles.cta}><div><span className={home.sectionEyebrow}>YOUR NEXT MAP</span><h2 id="create-title">开始你的下一张地图。</h2><p>从一个地点和一段描述开始，在工作台继续创作。</p></div><ButtonLink href={MAP_WORKSPACE_URL} target="_blank" rel="noopener noreferrer" size="lg">进入创作工作台<ArrowUpRight size={17} aria-hidden="true" /></ButtonLink></div><p className={styles.supportNote}>地图创作遇到问题？<ApplicationLink product="studio">提交接入问题与使用反馈</ApplicationLink></p></section>}
    </main>
    <Footer />
  </>;
}
