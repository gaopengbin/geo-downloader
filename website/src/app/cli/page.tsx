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
  description: "安装 GeoD CLI，在终端规划、下载并校验 GeoTIFF 影像和 GeoJSON 边界成果。",
  alternates: { canonical: "/cli" },
};

const cliInstall = "npm install -g geod-cli@0.1.1\ngeod --help";
const cliRequest = `{
  "schemaVersion": "1.0",
  "name": "河南边界",
  "bounds": [110.3, 31.3, 116.7, 36.5],
  "vector": {
    "url": "https://geo.datav.aliyun.com/areas_v3/bound/410000_full.json",
    "source": "https://geo.datav.aliyun.com/areas_v3/bound/410000_full.json",
    "attribution": "Alibaba Cloud DataV administrative boundaries",
    "layers": ["boundary"]
  },
  "limits": { "timeoutSeconds": 180 }
}`;
const cliWorkflow = "geod plan --request .\\henan-boundary.json\nif ($LASTEXITCODE -ne 0) { throw '请求校验失败' }\n$bundle = Join-Path (Get-Location) ('henan-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))\ngeod fetch --request .\\henan-boundary.json --out $bundle\nif ($LASTEXITCODE -ne 0) { throw '获取失败' }\ngeod inspect --bundle $bundle\nif ($LASTEXITCODE -ne 0) { throw '成果校验失败' }";

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
                <span className={styles.version}>0.1.1 · 公开预览版</span>
              </div>
              <p className={styles.description}>
                用参数请求规划和获取 GeoTIFF 影像、GeoJSON 边界等成果，输出可检查的 manifest。
                Windows 安装程序或便携包无需 Node.js；npm 安装需要 Node.js 18+。
              </p>
              <CodeBlock text={cliInstall} label="PowerShell · npm 安装" />
              <div className={styles.linkRow}>
                <a className={styles.primaryLink} href="https://github.com/gaopengbin/geo-downloader/releases/tag/geod-cli-v0.1.1" target="_blank" rel="noopener noreferrer">
                  <Download size={17} aria-hidden="true" /> 下载 Windows 安装包与便携版
                </a>
                <a href="https://www.npmjs.com/package/geod-cli" target="_blank" rel="noopener noreferrer">npm 包 <ArrowUpRight size={15} aria-hidden="true" /></a>
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
                将下面的请求保存为 <code>henan-boundary.json</code>，在同一目录依次执行规划、获取和校验。
                示例只获取 DataV 的河南行政区 GeoJSON；影像下载可在请求中加入 <code>imagery</code> 配置。
                输出目录必须是尚不存在的新目录。
              </p>
              <CodeBlock text={cliRequest} label="henan-boundary.json" />
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
