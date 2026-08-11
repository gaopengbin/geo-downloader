import Link from "next/link";
import cn from "classnames";
import MdiIcon from "@mdi/react";
import { mdiMicrosoftWindows } from "@mdi/js";
import { siApple, siAppimage, siDebian } from "simple-icons";
import {
  findReleaseAsset,
  getStableReleases,
  type ReleaseAssetKind,
} from "@/lib/github-releases";
import { TrackedDownloadLink } from "@/app/_components/ProductAnalytics";
import {
  ArrowRight,
  ArrowUpRight,
  FileImage,
  FileOutput,
  History,
  Layers3,
  ListChecks,
  MapPinned,
  MonitorCog,
  Mountain,
  Waypoints,
} from "lucide-react";

import Background from "../_components/Background";
import CTALink from "../_components/CTALink";
import Footer from "../_components/Footer";
import Header from "../_components/Header";
import { Tabs } from "../_components/Tabs";
import WindowShell from "../_components/WindowShell";
import "../home.css";
import styles from "../styles.module.css";

const repositoryUrl = "https://github.com/gaopengbin/geo-downloader";
const productModules = [
  {
    id: "geotiff",
    label: "GeoTIFF",
    title: "GeoTIFF 下载与导出",
    description: "多图源、区域选择与压缩导出。",
    image: "/geod/geotiff.png",
    alt: "GeoD GeoTIFF 下载与导出界面",
  },
  {
    id: "dem",
    label: "DEM",
    title: "DEM 高程数据",
    description: "基于 Terrain Tiles 的高程区域下载与导出。",
    image: "/geod/dem.png",
    alt: "GeoD DEM 高程数据下载界面",
  },
  {
    id: "tiles3d",
    label: "3D Tiles",
    title: "3D Tiles 下载",
    description: "Cesium Ion 与已获授权的 3D Tiles 服务空间过滤。",
    image: "/geod/3dtiles.png",
    alt: "GeoD 3D Tiles 下载界面",
  },
  {
    id: "wayback",
    label: "Wayback",
    title: "Wayback 历史影像",
    description: "通过时间轴回溯不同日期的卫星影像。",
    image: "/geod/wayback.png",
    alt: "GeoD Wayback 历史影像界面",
  },
  {
    id: "vector",
    label: "MVT",
    title: "矢量瓦片",
    description: "MVT / PBF 区域下载并保存为 PBF 目录或 MBTiles。",
    image: "/geod/vector.png",
    alt: "GeoD 矢量瓦片下载界面",
  },
] as const;

const ribbonItems = [
  { label: "遥感影像", Icon: MapPinned },
  { label: "数字高程", Icon: Mountain },
  { label: "3D Tiles", Icon: Layers3 },
  { label: "历史影像", Icon: History },
  { label: "矢量数据", Icon: Waypoints },
  { label: "GeoTIFF", Icon: FileImage },
  { label: "GIS 工作流", Icon: ListChecks },
];

const primaryFeatures = [
  {
    eyebrow: "01 / DATA SOURCES",
    title: "常用图源与自定义服务统一管理",
    description:
      "GeoD 提供常见服务的配置入口，也支持粘贴 XYZ / WMTS URL 模板。请在使用前确认数据提供方的授权范围、访问配额与离线使用政策。",
    meta: "图源管理 · XYZ / WMTS URL 模板",
    image: "/geod/geotiff.png",
    alt: "GeoD 图源与 GeoTIFF 工作界面",
  },
  {
    eyebrow: "02 / TERRAIN & 3D",
    title: "从 DEM 到 3D Tiles，一套工具完成",
    description:
      "按行政区、手绘范围或导入的矢量边界下载 Terrain Tiles 高程数据；对 Cesium Ion 与用户已获授权的 3D Tiles 服务进行空间过滤并创建任务。",
    meta: "DEM · 3D Tiles · LOD 过滤",
    image: "/geod/3dtiles.png",
    alt: "GeoD 3D Tiles 下载工作界面",
  },
  {
    eyebrow: "03 / HISTORY",
    title: "用时间轴找回历史影像",
    description:
      "通过 Esri World Imagery Wayback 浏览不同日期的影像版本，快速对比区域变化，再把当前选定的历史影像加入下载任务。",
    meta: "Esri Wayback · 时间轴",
    image: "/geod/wayback.png",
    alt: "GeoD Wayback 历史影像工作界面",
  },
] as const;

const secondaryFeatures = [
  {
    title: "多种空间选区",
    description: "联动行政区、手绘范围，或直接导入 GeoJSON、Shapefile、KML / KMZ。",
    label: "BOUNDARY / VECTOR IMPORT",
    metric: "GeoJSON · SHP · KML",
    Icon: MapPinned,
  },
  {
    title: "可靠的大任务执行",
    description: "多任务并行、断点续传与失败重试，让长时间任务更稳定、更可控。",
    label: "RESUME / RETRY / CACHE",
    metric: "并行 · 续传 · 重试",
    Icon: ListChecks,
  },
  {
    title: "GeoTIFF 专业导出",
    description: "自动写入坐标投影标签，支持 LZW / Deflate 压缩和大范围 BigTIFF。",
    label: "GEOTIFF / BIGTIFF",
    metric: "LZW · DEFLATE · BIGTIFF",
    Icon: FileOutput,
  },
  {
    title: "跨平台桌面体验",
    description: "Windows、macOS 与 Linux 原生运行，缓存目录也可以按工作环境迁移。",
    label: "WINDOWS / MACOS / LINUX",
    metric: "Windows · macOS · Linux",
    Icon: MonitorCog,
  },
] as const;

const downloadOptions = [
  { platform: "Windows", detail: "x64 · 安装包", iconPath: mdiMicrosoftWindows, kind: "windows" },
  { platform: "macOS", detail: "Apple Silicon · arm64", iconPath: siApple.path, kind: "mac-arm64" },
  { platform: "macOS", detail: "Intel · x64", iconPath: siApple.path, kind: "mac-x64" },
  { platform: "Linux", detail: "Debian / Ubuntu · .deb", iconPath: siDebian.path, kind: "linux-deb" },
  { platform: "Linux", detail: "通用 · AppImage", iconPath: siAppimage.path, kind: "linux-appimage" },
] as const;

export default async function SDKPage() {
  const [latestRelease] = await getStableReleases(1);

  const renderProductTabs = (className?: string) => (
    <div className={className}>
      <Tabs
        tabs={productModules.map((item) => ({
          id: item.id,
          label: item.label,
          content: (
            <WindowShell>
              <img
                className={styles.productImage}
                src={item.image}
                alt={item.alt}
                loading="lazy"
                decoding="async"
              />
            </WindowShell>
          ),
        }))}
      />
    </div>
  );

  return (
    <>
      <Background sticky />
      <main className={styles.home}>
        <Header isHome />

        <section
          className={cn(styles.heroSection, styles.section)}
          aria-labelledby="hero-title"
        >
          <span className={styles.heroKicker}>开源桌面 GIS 数据工作台</span>
          <h1 id="hero-title" className={styles.h1}>
            <span className={styles.heroBrand}>GeoD</span>
            <span className={styles.heroTitle}>让地理空间数据触手可及</span>
          </h1>
          <p className={cn(styles.p, styles.heroDescription)}>
            面向 GIS 工作流的桌面数据工具。选定区域、批量下载、断点续传并导出
            GeoTIFF、DEM、3D Tiles 与历史影像。
          </p>
          <div className={styles.heroActions}>
            <CTALink href="#download">下载最新版本</CTALink>
            <CTALink href="#features" variant="secondary">
              探索核心能力
            </CTALink>
            <a
              className={styles.heroGithub}
              href={repositoryUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              在 GitHub 查看源码
              <ArrowUpRight size={16} strokeWidth={1.8} aria-hidden="true" />
            </a>
          </div>

          <div className={styles.heroShowcase}>
            <Tabs
              tabs={productModules.slice(0, 3).map((item) => ({
                id: item.id,
                label: item.label,
                content: (
                  <WindowShell>
                    <img
                      className={styles.heroImage}
                      src={item.image}
                      alt={item.alt}
                      loading="eager"
                      fetchPriority="high"
                      decoding="sync"
                    />
                  </WindowShell>
                ),
              }))}
            />
          </div>
        </section>

        <hr className={styles.shadowSeparator} />

        <section className={cn(styles.section, styles.ribbonSection)}>
          <div className={styles.specialHeadingContainer}>
            <h2 className={styles.h2}>为 GIS 数据工作流提供动力</h2>
            <hr className={styles.separator} />
          </div>
          <div className={styles.logoMarquee} aria-label="GeoD 数据能力">
            <div className={styles.logoMarqueeTrack}>
              {[0, 1].map((copyIndex) => (
                <div
                  key={copyIndex}
                  className={styles.logoMarqueeGroup}
                  aria-hidden={copyIndex === 1}
                >
                  {ribbonItems.map((item) => (
                    <div key={`${copyIndex}-${item.label}`} className={styles.logoMarqueeItem}>
                      <item.Icon className={styles.ribbonMark} size={16} strokeWidth={1.8} aria-hidden="true" />
                      <span>{item.label}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="features" className={cn(styles.section, styles.featureSection)}>
          <div className={styles.specialHeadingContainer}>
            <h2 className={styles.h2}>核心能力</h2>
            <hr className={styles.separator} />
          </div>
          <h3 className={cn(styles.h1, styles.sectionTitle)}>
            把地图数据直接带到你的工作台
          </h3>
          <p className={cn(styles.p, styles.sectionLead)}>
            GeoD 把分散的地图数据获取流程收进一个桌面工作台。无需在多个脚本和工具之间来回切换，下载任务、空间边界与导出结果始终保持关联。
          </p>
          <CTALink href="#download" className={styles.featureCta}>
            下载 GeoD 开始使用
          </CTALink>

          {primaryFeatures.map((feature, index) => (
            <section
              key={feature.title}
              className={cn(
                styles.card,
                styles.featureCard,
                index % 2 === 1 && styles.cardReverse,
              )}
            >
              <div className={styles.cardCopy}>
                <span className={styles.cardEyebrow}>{feature.eyebrow}</span>
                <h4 className={styles.h4}>{feature.title}</h4>
                <p className={styles.p}>{feature.description}</p>
                <span className={styles.cardMeta}>{feature.meta}</span>
              </div>
              <img loading="lazy" src={feature.image} alt={feature.alt} />
            </section>
          ))}

          <div className={styles.compactFeatureGrid}>
            {secondaryFeatures.map((feature) => (
              <article key={feature.title} className={styles.compactFeatureCard}>
                <div className={styles.compactFeatureIcon} aria-hidden="true">
                  <feature.Icon size={20} strokeWidth={1.8} />
                </div>
                <div className={styles.compactFeatureCopy}>
                  <span className={styles.cardEyebrow}>{feature.label}</span>
                  <h4 className={styles.h4}>{feature.title}</h4>
                  <p className={styles.p}>{feature.description}</p>
                  <span className={styles.compactFeatureMetric}>{feature.metric}</span>
                </div>
                <span className={styles.compactFeatureArrow} aria-hidden="true">
                  <ArrowUpRight size={17} strokeWidth={1.8} />
                </span>
              </article>
            ))}
          </div>
        </section>

        <section id="screenshots" className={cn(styles.section, styles.productSection)}>
          <div className={styles.specialHeadingContainer}>
            <h2 className={styles.h2}>产品界面</h2>
            <hr className={styles.separator} />
          </div>
          <h3 className={cn(styles.h1, styles.sectionTitle)}>
            一个界面，串起完整工作流
          </h3>
          <p className={cn(styles.p, styles.sectionLead)}>
            地图交互、参数配置、任务进度与结果预览都围绕同一套桌面操作逻辑展开。切换模块，查看 GeoD 在不同数据场景下的真实界面。
          </p>
          {renderProductTabs(styles.productShowcase)}
          <div className={styles.moduleNotes}>
            {productModules.map((item) => (
              <div key={item.id} className={styles.moduleNote}>
                <span>{item.label}</span>
                <strong>{item.title}</strong>
                <small>{item.description}</small>
              </div>
            ))}
          </div>
        </section>

        <section id="download" className={cn(styles.section, styles.downloadSection)}>
          <div className={styles.specialHeadingContainer}>
            <h2 className={styles.h2}>下载 GeoD</h2>
            <hr className={styles.separator} />
          </div>
          <h3 className={cn(styles.h1, styles.sectionTitle)}>从正式版本开始你的下一次数据任务</h3>
          <p className={cn(styles.p, styles.sectionLead)}>
            GeoD 免费开源，支持 Windows、macOS 与 Linux。当前稳定版本为 {latestRelease.tag_name}，选择平台即可直接下载安装包。
          </p>
          <div className={styles.downloadIntro}>
            <div>
              <span className={styles.downloadLabel}>OFFICIAL RELEASE</span>
              <strong>选择平台，下载 {latestRelease.tag_name}</strong>
            </div>
            <span className={styles.downloadLicense}>免费开源 · MIT License</span>
          </div>
          <div className={styles.downloadGrid}>
            {downloadOptions.map((item) => (
              <TrackedDownloadLink
                key={`${item.platform}-${item.detail}`}
                className={cn(styles.card, styles.downloadCard)}
                href={
                  findReleaseAsset(latestRelease, item.kind as ReleaseAssetKind)
                    ?.browser_download_url ?? latestRelease.html_url
                }
                target="_blank"
                rel="noopener noreferrer"
                platform={item.kind}
                version={latestRelease.tag_name}
              >
                <span className={styles.downloadIcon} aria-hidden="true">
                  <MdiIcon path={item.iconPath} size={1.15} />
                </span>
                <span className={styles.downloadText}>
                  <strong>{item.platform}</strong>
                  <small>{item.detail}</small>
                </span>
                <span className={styles.downloadArrow} aria-hidden="true">
                  <ArrowUpRight size={18} strokeWidth={1.8} />
                </span>
              </TrackedDownloadLink>
            ))}
          </div>
          <p className={styles.downloadNote}>
            GitHub 下载速度较慢时，可以使用
            <a href="https://laogao.xyz/packages/latest/" target="_blank" rel="noopener noreferrer">
              国内高速镜像
            </a>
            。完整版本与 Release Notes 见
            <a href={`${repositoryUrl}/releases`} target="_blank" rel="noopener noreferrer">
              GitHub Releases
            </a>
            。
          </p>
        </section>

        <section id="resources" className={cn(styles.section, styles.resourcesSection)}>
          <div className={styles.specialHeadingContainer}>
            <h2 className={styles.h2}>资源与社区</h2>
            <hr className={styles.separator} />
          </div>
          <h3 className={cn(styles.h1, styles.sectionTitle)}>从安装到持续使用，入口都在这里</h3>
          <p className={cn(styles.p, styles.sectionLead)}>
            保留 GeoD 原有官网里的文档、版本、讨论和使用边界入口，帮助你快速开始，也方便持续跟进项目变化。
          </p>
          <div className={styles.resourceGrid}>
            <a className={cn(styles.card, styles.resourceCard)} href={`${repositoryUrl}#readme`} target="_blank" rel="noopener noreferrer">
              <span className={styles.cardEyebrow}>README</span>
              <strong>安装与使用说明</strong>
              <small>环境要求、运行方式与项目结构</small>
              <span className={styles.resourceArrow} aria-hidden="true">
                <ArrowUpRight size={18} strokeWidth={1.8} />
              </span>
            </a>
            <Link className={cn(styles.card, styles.resourceCard)} href="/history">
              <span className={styles.cardEyebrow}>RELEASE ARCHIVE</span>
              <strong>历史版本</strong>
              <small>查看版本时间线与各平台下载入口</small>
              <span className={styles.resourceArrow} aria-hidden="true">
                <ArrowRight size={18} strokeWidth={1.8} />
              </span>
            </Link>
            <a className={cn(styles.card, styles.resourceCard)} href={`${repositoryUrl}/discussions`} target="_blank" rel="noopener noreferrer">
              <span className={styles.cardEyebrow}>COMMUNITY</span>
              <strong>社区讨论</strong>
              <small>分享使用经验、问题与功能建议</small>
              <span className={styles.resourceArrow} aria-hidden="true">
                <ArrowUpRight size={18} strokeWidth={1.8} />
              </span>
            </a>
            <Link className={cn(styles.card, styles.resourceCard)} href="/disclaimer">
              <span className={styles.cardEyebrow}>TERMS</span>
              <strong>使用条款与免责声明</strong>
              <small>数据来源、授权边界与用户责任</small>
              <span className={styles.resourceArrow} aria-hidden="true">
                <ArrowRight size={18} strokeWidth={1.8} />
              </span>
            </Link>
          </div>
        </section>

        <section id="community" className={cn(styles.section, styles.communitySection)}>
          <div className={styles.communityPanel}>
            <div className={styles.communityCopy}>
              <span className={styles.cardEyebrow}>05 / COMMUNITY</span>
              <h3 className={styles.h4}>和真实用户一起，把工具打磨得更稳</h3>
              <p className={styles.p}>
                关注公众号获取版本更新、教程和常见问题说明；加入技术交流群，与 GIS 从业者讨论数据下载、处理与交付。
              </p>
              <div className={styles.communityNote}>
                二维码失效时，可添加微信 <strong>gpb230314</strong> 并备注 GeoD。
              </div>
            </div>
            <div className={styles.qrGrid}>
              <div className={styles.qrCard}>
                <img src="/geod/gzh.jpg" alt="GeoD 微信公众号二维码" loading="lazy" />
                <strong>微信公众号</strong>
                <span>版本更新、使用教程与问题说明</span>
              </div>
              <div className={styles.qrCard}>
                <img src="/geod/wxq_sq.png" alt="GeoD 技术交流群二维码" loading="lazy" />
                <strong>技术交流群</strong>
                <span>交流 GIS 数据下载、处理与交付经验</span>
              </div>
            </div>
          </div>
        </section>

        <section className={cn(styles.section, styles.finalCtaSection)}>
          <h3 className={cn(styles.h1, styles.sectionTitle)}>准备好开始下一次下载了吗？</h3>
          <p className={cn(styles.p, styles.sectionLead)}>从一个区域开始，把数据真正带回你的工作流。</p>
          <CTALink href="#download">立即下载 GeoD</CTALink>
        </section>

        <Footer />
      </main>
    </>
  );
}
