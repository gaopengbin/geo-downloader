import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Download, Terminal } from "lucide-react";
import Background from "../_components/Background";
import Footer from "../_components/Footer";
import Header from "../_components/Header";
import page from "../geod-page.module.css";
import CodeBlock from "../tools/CodeBlock";
import styles from "../tools/tools.module.css";

export const metadata: Metadata = {
  title: "GeoD CLI｜独立的命令行影像下载工具",
  description: "安装 GeoD CLI，在本机规划、下载和检查多级影像、GeoTIFF 与离线瓦片包。",
  alternates: { canonical: "/cli" },
};

const cliInstall = "npm install -g geod-cli@0.2.0\ngeod --version";
const cliRequest = `{
  "schemaVersion": "1.0",
  "name": "Blue Marble 多级影像示例",
  "bounds": [116.3, 39.8, 116.5, 40.0],
  "imagery": {
    "url": "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg",
    "source": "NASA GIBS Blue Marble Shaded Relief Bathymetry",
    "attribution": "NASA GIBS",
    "zoom": 5,
    "zoomLevels": [5, 6],
    "format": "geotiff",
    "compression": "deflate",
    "buildPyramid": true,
    "generateSidecars": true,
    "concurrency": 4
  }
}`;
const cliWorkflow = "geod plan --request .\\imagery.json\nif ($LASTEXITCODE -ne 0) { throw '请求校验失败' }\n$bundle = Join-Path (Get-Location) ('imagery-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))\ngeod fetch --request .\\imagery.json --out $bundle --work-dir .\\imagery-cache\nif ($LASTEXITCODE -ne 0) { throw '下载失败' }\ngeod inspect --bundle $bundle\nif ($LASTEXITCODE -ne 0) { throw '成果校验失败' }";

export default function CliPage() {
  return (
    <>
      <Background sticky />
      <Header />
      <main className={`${page.page} ${styles.toolsPage}`}>
        <div className={page.container}>
          <header className={`${page.head} ${styles.compactHead}`}>
            <span className={page.eyebrow}>GEOD / COMMAND LINE</span>
            <h1 className={page.title}>GeoD CLI</h1>
            <p className={page.lead}>在终端独立规划、下载和校验地理数据，按需接入自己的脚本与工作流。</p>
            <div className={page.toolbar}>
              <a className={styles.heroPrimary} href="#install">安装 CLI</a>
              <a href="#example">查看命令示例</a>
              <Link href="/">返回官网首页</Link>
            </div>
          </header>

          <div className={styles.content}>
            <section id="install" className={styles.toolSection} aria-labelledby="cli-title">
              <div className={styles.sectionHeading}>
                <span className={styles.icon}><Terminal size={23} strokeWidth={1.8} aria-hidden="true" /></span>
                <div>
                  <span className={styles.kicker}>INSTALL / WINDOWS X64</span>
                  <h2 id="cli-title">安装 GeoD CLI</h2>
                </div>
                <span className={styles.version}>0.2.0 · Windows x64</span>
              </div>
              <p className={styles.description}>
                本机下载多级影像，输出 GeoTIFF、PNG/JPEG、原始瓦片、MBTiles 或 GeoPackage；支持叠加、裁剪、金字塔、辅助文件和断点续传。
                安装程序或便携包无需 Node.js；通过 npm 安装发布包需要 Node.js 18+。
              </p>
                <CodeBlock text={cliInstall} label="PowerShell · npm 安装" />
              <div className={styles.linkRow}>
                <a className={styles.primaryLink} href="https://github.com/gaopengbin/geo-downloader/releases/tag/geod-cli-v0.2.0" target="_blank" rel="noopener noreferrer">
                  <Download size={17} aria-hidden="true" /> 下载 Windows 安装包与便携版
                </a>
                <a href="https://www.npmjs.com/package/geod-cli/v/0.2.0" target="_blank" rel="noopener noreferrer">npm 包 <ArrowUpRight size={15} aria-hidden="true" /></a>
                <a href="https://github.com/gaopengbin/geo-downloader/releases/download/geod-cli-v0.2.0/SHA256SUMS.txt" target="_blank" rel="noopener noreferrer">校验文件 <ArrowUpRight size={15} aria-hidden="true" /></a>
                <a href="#example">命令与示例 <ArrowRight size={15} aria-hidden="true" /></a>
              </div>
            </section>

            <section id="example" className={styles.toolSection} aria-labelledby="example-title">
              <div className={styles.sectionHeading}>
                <span className={styles.icon}><Download size={23} strokeWidth={1.8} aria-hidden="true" /></span>
                <div>
                  <span className={styles.kicker}>CLI / QUICK START</span>
                  <h2 id="example-title">独立运行下载任务</h2>
                </div>
              </div>
              <p className={styles.description}>
                将下面的请求保存为 <code>imagery.json</code>，依次规划、下载和检查成果。
                示例从 NASA GIBS 获取两个级别的影像；请按数据源授权和服务限制使用。输出目录必须是新目录，缓存目录可在重试时复用。
              </p>
              <CodeBlock text={cliRequest} label="imagery.json" />
              <CodeBlock text={cliWorkflow} label="PowerShell · 下载与校验" />
              <p className={styles.description}>
                下载成功后，目录中会生成数据文件和 <code>manifest.json</code>。请检查其中的来源、范围、质量及警告；
                <code>plan</code> 的估算结果不能证明数据源当前可用。
              </p>
            </section>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
