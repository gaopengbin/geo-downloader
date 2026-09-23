import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Bot } from "lucide-react";
import Background from "../_components/Background";
import Footer from "../_components/Footer";
import Header from "../_components/Header";
import page from "../geod-page.module.css";
import CodeBlock from "../tools/CodeBlock";
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
const localInstall = '$pkg = "https://laogao.xyz/geod-mcp/geod-mcp-0.1.2.tgz"\nnpx --yes --package $pkg geod-mcp install codex --package $pkg';
const agentPrompt = `请将 GeoD 影像下载 MCP 接入当前 Agent。使用 Streamable HTTP 地址 ${remoteUrl}，按客户端支持的 OAuth 流程引导我用自己的 GeoD 账号在浏览器中授权，不要索取我的密码或验证码。接入后实际调用 geod_capabilities 和 geod_plan 验证；geod_plan 只做规划，不要启动下载任务。请报告验证结果和接入位置；如果客户端不支持 Streamable HTTP 或 OAuth，请说明具体阻碍。`;

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
              <span className={styles.kicker}>COPY / PASTE</span>
              <h2 id="prompt-title">一句话让 Agent 接入</h2>
              <p>把下面这段发给你的 Agent，通过 GeoD 账号授权后验证工具是否可用。</p>
              <CodeBlock text={agentPrompt} label="GeoD MCP · HTTPS 接入提示词" />
            </section>

            <section id="connect" className={styles.toolSection} aria-labelledby="connect-title">
              <div className={styles.sectionHeading}>
                <span className={styles.icon}><Bot size={23} strokeWidth={1.8} aria-hidden="true" /></span>
                <div>
                  <span className={styles.kicker}>CONNECT / AGENT TOOLS</span>
                  <h2 id="connect-title">选择 MCP 接入方式</h2>
                </div>
                <span className={styles.version}>0.1.2 · HTTPS 或本机</span>
              </div>
              <p className={styles.description}>
                Agent 可以先调用 <code>geod_plan</code> 估算，再用 <code>geod_fetch</code> 启动任务，
                查看进度并读取预览和数据文件。
              </p>
              <div className={styles.methodGrid}>
                <article className={styles.method}>
                  <div className={styles.methodLabel}>推荐 · 通过账号授权</div>
                  <h3>HTTPS MCP</h3>
                  <p>添加远端地址，并在浏览器中使用自己的 GeoD 账号授权。客户端需要支持 Streamable HTTP 与 OAuth。</p>
                  <CodeBlock text={remoteUrl} label="MCP 服务地址" />
                  <CodeBlock text={remoteConfig} label="支持 mcpServers 的客户端示例" />
                  <p className={styles.finePrint}>远端服务按账号隔离任务，每个账号每天最多 3 次下载任务；豆包工作的实际客户端兼容性仍需测试。</p>
                </article>
                <article className={styles.method}>
                  <div className={styles.methodLabel}>在自己的电脑上运行</div>
                  <h3>本机 MCP</h3>
                  <p>Windows x64、Node.js 22+。任务和成果默认保存在使用者自己的 %LOCALAPPDATA%\\GeoD\\Workspace；Codex 和 WorkBuddy 有安装目标。</p>
                  <CodeBlock text={localInstall} label="PowerShell · Codex 示例" />
                  <p className={styles.finePrint}>只有想更换工作空间时才加 <code>--workspace</code> 并填写自己电脑上的绝对路径；WorkBuddy 把命令中的 <code>codex</code> 换成 <code>workbuddy</code>。</p>
                </article>
              </div>
              <div className={styles.linkRow}>
                <a className={styles.primaryLink} href="https://github.com/gaopengbin/geo-downloader/releases/tag/geod-mcp-v0.1.2" target="_blank" rel="noopener noreferrer">
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
