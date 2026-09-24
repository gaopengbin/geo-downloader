import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Bot } from "lucide-react";
import Background from "../_components/Background";
import Footer from "../_components/Footer";
import Header from "../_components/Header";
import page from "../geod-page.module.css";
import CodeBlock from "../tools/CodeBlock";
import CopyText from "../tools/CopyText";
import styles from "../tools/tools.module.css";

export const metadata: Metadata = {
  title: "GeoD MCP｜让 Agent 调用影像下载工具",
  description: "将 GeoD MCP 接入 Codex、WorkBuddy 等 Agent。提供 HTTPS MCP 地址、账号授权说明和本机 MCP 安装方式。",
  alternates: { canonical: "/mcp" },
};

const remoteUrl = "https://laogao.xyz/geod-mcp/mcp";
const remoteConfig = `{
  "mcpServers": {
    "geod": {
      "type": "http",
      "url": "${remoteUrl}"
    }
  }
}`;
const skillUrl = "https://geod.laogao.xyz/skills/geod-agent/SKILL.md";
const skillZipUrl = "https://geod.laogao.xyz/skills/geod-agent.zip";
const localInstall = '$pkg = "https://laogao.xyz/geod-mcp/geod-mcp-0.1.4.tgz"\nnpx --yes --package $pkg geod-mcp install codex --package $pkg';
const agentPrompt = `请从 ${skillUrl} 安装 GeoD Skill，并为当前 Agent 配置 GeoD MCP；通过 MCP 工具完成一次只读规划验证。`;

export default function McpPage() {
  return (
    <>
      <Background sticky />
      <Header />
      <main className={`${page.page} ${styles.toolsPage}`}>
        <div className={page.container}>
          <header className={`${page.head} ${styles.compactHead}`}>
            <span className={page.eyebrow}>GEOD / AGENT TOOLS</span>
            <h1 className={page.title}>GeoD MCP</h1>
            <p className={page.lead}>让 Agent 调用 GeoD 的影像规划、下载任务和成果读取工具。</p>
            <div className={page.toolbar}>
              <a className={styles.heroPrimary} href="#prompt">复制接入提示词</a>
              <a href="#connect">查看接入方式</a>
              <Link href="/">返回官网首页</Link>
            </div>
          </header>

          <div className={styles.content}>
            <section id="prompt" className={styles.promptSection} aria-labelledby="prompt-title">
              <span className={styles.kicker}>INSTALL / AGENT SKILL</span>
              <h2 id="prompt-title">安装 GeoD Skill</h2>
              <p>复制这一句话给当前 Agent。接入方式、图源与裁剪等细节由 Skill 指引。</p>
              <div className={styles.installPrompt}>
                <p>{agentPrompt}</p>
                <CopyText text={agentPrompt} label="复制给 Agent" />
              </div>
              <p className={styles.installNote}>浏览器方式无需安装；本机 MCP 需要 Windows x64 和 Node.js 22+。旧版 geod-agent 安装器配置的是远端服务。</p>
            </section>

            <section id="connect" className={styles.toolSection} aria-labelledby="connect-title">
              <div className={styles.sectionHeading}>
                <span className={styles.icon}><Bot size={23} strokeWidth={1.8} aria-hidden="true" /></span>
                <div>
                  <span className={styles.kicker}>CONNECT / AGENT TOOLS</span>
                  <h2 id="connect-title">选择 MCP 接入方式</h2>
                </div>
                <span className={styles.version}>MCP 0.1.4 · HTTPS 或本机</span>
              </div>
              <p className={styles.description}>在用户电脑运行的 Agent 优先接入本机 MCP；云端 Agent 可接入 HTTPS MCP。浏览器 WebMCP 只在你主动选择网页处理时使用。</p>
              <div className={styles.methodGrid}>
                <article className={styles.method}>
                  <div className={styles.methodLabel}>推荐 · 本机完整 CLI 流程</div>
                  <h3>本机 MCP</h3>
                  <p>Windows x64、Node.js 22+。任务和成果保存在使用者自己的 %LOCALAPPDATA%\\GeoD\\Workspace；安装命令同时配置 MCP 与 GeoD Skill。</p>
                  <CodeBlock text={localInstall} label="PowerShell · Codex 示例" />
                  <p className={styles.finePrint}>本机 MCP 可用 <code>geod_sources</code> 列出图源、注册自己的授权图源，再在规划和下载任务中填写 <code>imagery.sourceId</code>。图源配置留在当前用户电脑上。</p>
                  <p className={styles.finePrint}>只有想更换工作空间时才加 <code>--workspace</code> 并填写自己电脑上的绝对路径；WorkBuddy 把命令中的 <code>codex</code> 换成 <code>workbuddy</code>。</p>
                </article>
                <article className={styles.method}>
                  <div className={styles.methodLabel}>云端 Agent · 使用服务器资源</div>
                  <h3>HTTPS MCP</h3>
                  <p>Marvis 等客户端可手动添加远端地址与 GeoD Skill，并在浏览器中使用自己的 GeoD 账号授权。客户端需要支持 Streamable HTTP 与 OAuth。下载和拼接在 GeoD 服务器上执行。</p>
                  <CodeBlock text={remoteUrl} label="MCP 服务地址" />
                  <a href={skillUrl} target="_blank" rel="noopener noreferrer">查看 GeoD Agent Skill <ArrowUpRight size={14} aria-hidden="true" /></a>
                  <CodeBlock text={remoteConfig} label="支持 mcpServers 的客户端示例" />
                  <p className={styles.finePrint}>WorkBuddy 可在技能页面<a href={skillZipUrl}>导入 Skill ZIP</a>。远端 MCP 只开放 NASA GIBS 图源，不接受自定义图源注册；按账号隔离任务，每个账号每天最多 3 次下载任务。豆包工作的实际客户端兼容性仍需测试。</p>
                </article>
                <article className={`${styles.method} ${styles.remoteMethod}`}>
                  <div className={styles.methodLabel}>按需选择 · 浏览器本机计算</div>
                  <h3>WebMCP 页面</h3>
                  <p>明确选择网页处理时，打开浏览器端影像下载页面。网页直接请求瓦片，在当前设备拼接、按 GeoJSON 多边形裁剪并保存 PNG 数据包。只有 Agent 真正获得页面注入的 WebMCP 工具，才能通过工具调用；打开网页本身不等于接入成功。</p>
                  <div className={styles.linkRow}><Link href="/browser">打开浏览器端下载 <ArrowUpRight size={16} aria-hidden="true" /></Link></div>
                  <p className={styles.finePrint}>可选内置 NASA 图源或在当前浏览器注册自己的授权图源。自定义图源只保存在当前浏览器，必须允许 HTTPS 跨域读取（CORS）；使用 WebMCP 时保持页面打开。浏览器版导出 PNG、定位文件和可选裁剪边界；其他影像格式与处理请使用本机 MCP。</p>
                </article>
              </div>
              <div className={styles.linkRow}>
                <a href="https://www.npmjs.com/package/geod-agent" target="_blank" rel="noopener noreferrer">
                  远端 MCP 安装器 <ArrowUpRight size={16} aria-hidden="true" />
                </a>
                <a className={styles.primaryLink} href="https://github.com/gaopengbin/geo-downloader/releases/tag/geod-mcp-v0.1.4" target="_blank" rel="noopener noreferrer">
                  查看 MCP 安装包与校验值 <ArrowUpRight size={16} aria-hidden="true" />
                </a>
              </div>
            </section>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
