import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Bot, Download, Terminal } from "lucide-react";
import Background from "../_components/Background";
import Footer from "../_components/Footer";
import Header from "../_components/Header";
import { CLI_EXPERIENCE_URL } from "@/lib/site";
import page from "../geod-page.module.css";
import styles from "./tools.module.css";
import CopyText from "./CopyText";

export const metadata: Metadata = {
  title: "GeoD CLI 与 MCP｜命令行下载和 Agent 接入",
  description: "安装 GeoD CLI，或将 GeoD 影像下载 MCP 接入 Codex、WorkBuddy 等 Agent。提供本机安装、HTTPS MCP 地址与可复制的接入提示词。",
  alternates: { canonical: "/tools" },
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
const localInstall = '$pkg = "https://laogao.xyz/geod-mcp/geod-mcp-0.1.1.tgz"\nnpx --yes --package $pkg geod-mcp install codex --package $pkg --workspace "C:\\path\\to\\your\\workspace"';
const remoteUrl = "https://laogao.xyz/geod-mcp/mcp";
const remoteConfig = `{
  "mcpServers": {
    "geod": {
      "type": "http",
      "url": "${remoteUrl}"
    }
  }
}`;
const agentPrompt = `请把 GeoD 的影像下载 MCP 接入当前 Agent。如果你运行在我的 Windows x64 电脑上且有 Node.js 22+，从 https://laogao.xyz/geod-mcp/geod-mcp-0.1.1.tgz 安装本机 MCP，并把当前工作目录作为 workspace；Codex 使用 codex 安装目标，WorkBuddy 使用 workbuddy。如果你运行在云端，请添加 ${remoteUrl} 作为 Streamable HTTP MCP，让我在浏览器中使用自己的 GeoD 账号完成授权。接入后实际调用 geod_capabilities 和 geod_plan 验证，并报告结果或具体阻碍。不要使用发布者的电脑路径或令牌。`;

function CodeBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <span>{label}</span>
        <CopyText text={text} label="复制" />
      </div>
      <pre><code>{text}</code></pre>
    </div>
  );
}

export default function ToolsPage() {
  return (
    <>
      <Background sticky />
      <Header />
      <main className={`${page.page} ${styles.toolsPage}`}>
        <div className={page.container}>
          <header className={`${page.head} ${styles.compactHead}`}>
            <span className={page.eyebrow}>GEOD / DEVELOPER TOOLS</span>
            <h1 className={page.title}>GeoD CLI 与 MCP</h1>
            <p className={page.lead}>
              复制提示词，让 Agent 接入 GeoD 影像下载；也可以安装 CLI，自行规划、下载并校验成果。
            </p>
            <div className={page.toolbar}>
              <a className={styles.heroPrimary} href="#prompt">复制接入提示词</a>
              <a href="#cli">查看 CLI</a>
              <a href="#mcp">MCP 安装方式</a>
              <Link href="/">返回官网首页</Link>
            </div>
          </header>

          <div className={styles.content}>
            <section id="prompt" className={styles.promptSection} aria-labelledby="prompt-title">
              <span className={styles.kicker}>01 / COPY & PASTE</span>
              <h2 id="prompt-title">一句话让 Agent 接入</h2>
              <p>把下面这段发给你自己的 Agent。它会根据运行环境选择本机安装或远端服务，并实际调用工具验证。</p>
              <CodeBlock text={agentPrompt} label="GeoD MCP 接入提示词" />
            </section>

            <section id="cli" className={styles.toolSection} aria-labelledby="cli-title">
              <div className={styles.sectionHeading}>
                <span className={styles.icon}><Terminal size={23} strokeWidth={1.8} aria-hidden="true" /></span>
                <div>
                  <span className={styles.kicker}>02 / SCRIPTABLE DOWNLOADS</span>
                  <h2 id="cli-title">GeoD CLI</h2>
                </div>
                <span className={styles.version}>0.1.1 · Windows x64 公开预览版</span>
              </div>
              <p className={styles.description}>
                用参数请求规划和获取 GeoTIFF 影像、GeoJSON 边界等成果，输出可检查的 manifest。
                安装程序或便携包无需 Node.js；npm 安装需要 Node.js 18+。
              </p>
              <CodeBlock text={cliInstall} label="PowerShell · npm 安装" />
              <div className={styles.linkRow}>
                <a className={styles.primaryLink} href="https://github.com/gaopengbin/geo-downloader/releases/tag/geod-cli-v0.1.1" target="_blank" rel="noopener noreferrer">
                  <Download size={17} aria-hidden="true" /> 下载 Windows 安装包与便携版
                </a>
                <a href="https://www.npmjs.com/package/geod-cli" target="_blank" rel="noopener noreferrer">npm 包 <ArrowUpRight size={15} aria-hidden="true" /></a>
                <a href="#cli-guide">命令与示例 <ArrowRight size={15} aria-hidden="true" /></a>
              </div>
            </section>

            <section id="cli-guide" className={styles.toolSection} aria-labelledby="cli-guide-title">
              <div className={styles.sectionHeading}>
                <span className={styles.icon}><Download size={23} strokeWidth={1.8} aria-hidden="true" /></span>
                <div>
                  <span className={styles.kicker}>CLI / QUICK START</span>
                  <h2 id="cli-guide-title">独立运行下载任务</h2>
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

            <section id="mcp" className={styles.toolSection} aria-labelledby="mcp-title">
              <div className={styles.sectionHeading}>
                <span className={styles.icon}><Bot size={23} strokeWidth={1.8} aria-hidden="true" /></span>
                <div>
                  <span className={styles.kicker}>03 / AGENT TOOLS</span>
                  <h2 id="mcp-title">GeoD MCP</h2>
                </div>
                <span className={styles.version}>0.1.1 · 本机或 HTTPS</span>
              </div>
              <p className={styles.description}>
                Agent 可以先调用 <code>geod_plan</code> 估算，再用 <code>geod_fetch</code> 启动任务，
                查看进度并读取预览和数据文件。它围绕影像与边界数据的获取、校验和交付运行。
              </p>
              <div className={styles.methodGrid}>
                <article className={styles.method}>
                  <div className={styles.methodLabel}>在自己的电脑上运行</div>
                  <h3>本机 MCP</h3>
                  <p>Windows x64、Node.js 22+。任务和成果保存在使用者自己的工作目录；Codex 和 WorkBuddy 有安装目标。</p>
                  <CodeBlock text={localInstall} label="PowerShell · Codex 示例" />
                  <p className={styles.finePrint}>将示例路径换成你电脑上的绝对路径；WorkBuddy 把命令中的 <code>codex</code> 换成 <code>workbuddy</code>。</p>
                </article>
                <article className={styles.method}>
                  <div className={styles.methodLabel}>在云端 Agent 中使用</div>
                  <h3>HTTPS MCP</h3>
                  <p>添加远端地址，并在浏览器中使用自己的 GeoD 账号授权。客户端需要支持 Streamable HTTP 与 OAuth。</p>
                  <CodeBlock text={remoteUrl} label="MCP 服务地址" />
                  <CodeBlock text={remoteConfig} label="支持 mcpServers 的客户端示例" />
                  <p className={styles.finePrint}>远端服务按账号隔离任务，每个账号每天最多 3 次下载任务；豆包工作的实际客户端兼容性仍需测试。</p>
                </article>
              </div>
              <div className={styles.linkRow}>
                <a className={styles.primaryLink} href="https://github.com/gaopengbin/geo-downloader/releases/tag/geod-mcp-v0.1.1" target="_blank" rel="noopener noreferrer">
                  查看 MCP 安装包与校验值 <ArrowUpRight size={16} aria-hidden="true" />
                </a>
                <a href={CLI_EXPERIENCE_URL}>浏览器里的 CLI 预览 <ArrowRight size={15} aria-hidden="true" /></a>
              </div>
            </section>

          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
