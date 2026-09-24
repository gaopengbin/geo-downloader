import type { Metadata } from "next";
import Link from "next/link";
import Background from "../_components/Background";
import Footer from "../_components/Footer";
import Header from "../_components/Header";
import page from "../geod-page.module.css";
import BrowserImagery from "./BrowserImagery";
import styles from "./browser.module.css";

export const metadata: Metadata = {
  title: "GeoD 浏览器端影像下载｜本机拼接与 WebMCP",
  description: "在浏览器中直接下载、拼接并按 GeoJSON 多边形裁剪影像，注册自己的 HTTPS 图源，输出带地理定位的 PNG 数据包。支持 WebMCP 工具。",
  alternates: { canonical: "/browser" },
};

export default function BrowserPage() {
  return <>
    <Background sticky />
    <Header />
    <main className={`${page.page} ${styles.browserPage}`}>
      <div className={page.container}>
        <header className={page.head}>
          <span className={page.eyebrow}>GEOD / BROWSER COMPUTE</span>
          <h1 className={page.title}>影像在你的浏览器里完成</h1>
          <p className={page.lead}>瓦片由你的浏览器直接获取、拼接、按多边形裁剪并保存。GeoD 官网只提供页面代码，不代理影像下载，也不在服务器上运行拼接任务。</p>
          <div className={page.toolbar}>
            <a href="#browser-workspace">开始下载</a>
            <Link href="/mcp">查看其他 Agent 接入方式</Link>
          </div>
        </header>
        <section id="browser-workspace" className={styles.intro} aria-label="浏览器端能力说明">
          <div><strong>本机执行</strong><span>网络、CPU、内存由当前设备承担</span></div>
          <div><strong>无需安装</strong><span>普通浏览器可手动操作</span></div>
          <div><strong>WebMCP</strong><span>支持网页工具的 Agent 可直接调用</span></div>
        </section>
        <BrowserImagery />
      </div>
    </main>
    <Footer />
  </>;
}
