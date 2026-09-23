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
const agentInstall = "npx -y geod-agent@latest install";
const localInstall = '$pkg = "https://laogao.xyz/geod-mcp/geod-mcp-0.1.3.tgz"\nnpx --yes --package $pkg geod-mcp install codex --package $pkg';
const agentPrompt = `请运行 ${agentInstall}，为当前 Agent 安装 GeoD Skill 和远程影像下载 MCP；若需选择客户端，使用 install codex 或 install workbuddy。安装后加载 Skill，引导我用自己的 GeoD 账号授权，再调用 geod_capabilities、geod_plan 验证，不要启动下载。无法运行命令时参照 https://geod.laogao.xyz/mcp 手动接入。`;

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
              <p>复制这段话给本地 Agent。安装器会配置 Skill 和 HTTPS MCP，再引导你使用自己的 GeoD 账号授权。</p>
              <div className={styles.installPrompt}>
                <p>{agentPrompt}</p>
                <CopyText text={agentPrompt} label="复制给 Agent" />
              </div>
              <p className={styles.installNote}>需要 Node.js 20+；云端 Agent 无法运行本机命令时，可使用下方的 HTTPS MCP 地址和 Skill 文件。</p>
            </section>

            <section id="connect" className={styles.toolSection} aria-labelledby="connect-title">
              <div className={styles.sectionHeading}>
                <span className={styles.icon}><Bot size={23} strokeWidth={1.8} aria-hidden="true" /></span>
                <div>
                  <span className={styles.kicker}>CONNECT / AGENT TOOLS</span>
                  <h2 id="connect-title">选择 MCP 接入方式</h2>
                </div>
                <span className={styles.version}>MCP 0.1.3 · HTTPS 或本机</span>
              </div>
              <p className={styles.description}>
                Agent 可以先调用 <code>geod_plan</code> 估算，再用 <code>geod_fetch</code> 启动任务，
                查看进度并读取预览和数据文件。
              </p>
              <div className={styles.methodGrid}>
                <article className={styles.method}>
                  <div className={styles.methodLabel}>推荐 · 通过账号授权</div>
                  <h3>HTTPS MCP</h3>
                  <p>使用安装器 <code>{agentInstall}</code>，或手动添加远端地址与 GeoD Skill，并在浏览器中使用自己的 GeoD 账号授权。客户端需要支持 Streamable HTTP 与 OAuth。</p>
                  <CodeBlock text={remoteUrl} label="MCP 服务地址" />
                  <a href={skillUrl} target="_blank" rel="noopener noreferrer">查看 GeoD Agent Skill <ArrowUpRight size={14} aria-hidden="true" /></a>
                  <CodeBlock text={remoteConfig} label="支持 mcpServers 的客户端示例" />
                  <p className={styles.finePrint}>WorkBuddy 可在技能页面<a href={skillZipUrl}>导入 Skill ZIP</a>。远端服务按账号隔离任务，每个账号每天最多 3 次下载任务；豆包工作的实际客户端兼容性仍需测试。</p>
                </article>
                <article className={styles.method}>
                  <div className={styles.methodLabel}>在自己的电脑上运行</div>
                  <h3>本机 MCP</h3>
                  <p>Windows x64、Node.js 22+。任务和成果默认保存在使用者自己的 %LOCALAPPDATA%\\GeoD\\Workspace；安装器会同时配置 MCP 与 GeoD Skill。</p>
                  <CodeBlock text={localInstall} label="PowerShell · Codex 示例" />
                  <p className={styles.finePrint}>只有想更换工作空间时才加 <code>--workspace</code> 并填写自己电脑上的绝对路径；WorkBuddy 把命令中的 <code>codex</code> 换成 <code>workbuddy</code>。</p>
                </article>
              </div>
              <div className={styles.linkRow}>
                <a href="https://www.npmjs.com/package/geod-agent" target="_blank" rel="noopener noreferrer">
                  GeoD Agent 安装器 <ArrowUpRight size={16} aria-hidden="true" />
                </a>
                <a className={styles.primaryLink} href="https://github.com/gaopengbin/geo-downloader/releases/tag/geod-mcp-v0.1.3" target="_blank" rel="noopener noreferrer">
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
