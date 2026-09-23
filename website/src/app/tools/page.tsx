import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Bot, Terminal } from "lucide-react";
import Background from "../_components/Background";
import Footer from "../_components/Footer";
import Header from "../_components/Header";
import page from "../geod-page.module.css";
import styles from "./tools.module.css";

export const metadata: Metadata = {
  title: "GeoD 开发者工具",
  description: "分别查看 GeoD CLI 命令行下载工具与 GeoD MCP Agent 接入方式。",
  alternates: { canonical: "/tools" },
};

export default function ToolsPage() {
  return (
    <>
      <Background sticky />
      <Header />
      <main className={`${page.page} ${styles.toolsPage}`}>
        <div className={page.container}>
          <header className={`${page.head} ${styles.compactHead}`}>
            <span className={page.eyebrow}>GEOD / DEVELOPER TOOLS</span>
            <h1 className={page.title}>选择你的工具</h1>
            <p className={page.lead}>CLI 用于终端脚本，MCP 用于 Agent 调用。各自有独立的接入说明。</p>
          </header>
          <div className={styles.content}>
            <section className={styles.toolSection} aria-labelledby="cli-title">
              <div className={styles.sectionHeading}>
                <span className={styles.icon}><Terminal size={23} strokeWidth={1.8} aria-hidden="true" /></span>
                <div><span className={styles.kicker}>COMMAND LINE</span><h2 id="cli-title">GeoD CLI</h2></div>
              </div>
              <p className={styles.description}>安装独立命令行工具，在自己的终端规划、下载并检查数据成果。</p>
              <div className={styles.linkRow}><Link className={styles.primaryLink} href="/cli">查看 CLI <ArrowRight size={16} aria-hidden="true" /></Link></div>
            </section>
            <section className={styles.toolSection} aria-labelledby="mcp-title">
              <div className={styles.sectionHeading}>
                <span className={styles.icon}><Bot size={23} strokeWidth={1.8} aria-hidden="true" /></span>
                <div><span className={styles.kicker}>AGENT TOOLS</span><h2 id="mcp-title">GeoD MCP</h2></div>
              </div>
              <p className={styles.description}>将 GeoD 影像下载工具接入 Agent，并使用 GeoD 账号授权。</p>
              <div className={styles.linkRow}><Link className={styles.primaryLink} href="/mcp">查看 MCP <ArrowRight size={16} aria-hidden="true" /></Link></div>
            </section>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
