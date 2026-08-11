import type { Metadata } from "next";
import Link from "next/link";

import {
  formatAssetLabel,
  formatBytes,
  getStableReleases,
  sortReleaseAssets,
} from "@/lib/github-releases";
import Footer from "../_components/Footer";
import Background from "../_components/Background";
import Header from "../_components/Header";
import styles from "../geod-page.module.css";

export const metadata: Metadata = {
  title: "历史版本",
  description: "GeoD 正式发布版本、平台安装包与更新入口。",
  alternates: { canonical: "/history" },
};

const repositoryUrl = "https://github.com/gaopengbin/geo-downloader";

export default async function HistoryPage() {
  const releases = await getStableReleases(15);

  return (
    <>
      <Background sticky />
      <Header />
      <main className={styles.page}>
        <div className={styles.container}>
          <header className={styles.head}>
            <span className={styles.eyebrow}>Release Archive</span>
            <h1 className={styles.title}>历史版本</h1>
            <p className={styles.lead}>
              这里与 GitHub Releases 同步，只展示正式版本。选择平台即可直接下载安装包，也可以切换到国内镜像。
            </p>
            <div className={styles.toolbar}>
              <a href="https://laogao.xyz/packages/" target="_blank" rel="noopener noreferrer">
                国内高速镜像
              </a>
              <a href={`${repositoryUrl}/releases`} target="_blank" rel="noopener noreferrer">
                GitHub Releases
              </a>
              <Link href="/">返回首页</Link>
            </div>
          </header>

          <div className={styles.releaseList}>
            {releases.map((release, index) => (
              <article key={release.tag_name} className={styles.releaseCard}>
                <div className={styles.releaseHead}>
                  <div>
                    <div className={styles.releaseTitle}>
                      {release.tag_name}
                      {index === 0 ? <span className={styles.latest}>最新稳定版</span> : null}
                    </div>
                    <div className={styles.releaseDate}>
                      {new Intl.DateTimeFormat("zh-CN", {
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                      }).format(new Date(release.published_at))}
                    </div>
                  </div>
                  <a
                    className={styles.releaseNotes}
                    href={release.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    查看更新说明 ↗
                  </a>
                </div>
                <div className={styles.assetGrid}>
                  {release.assets.length > 0 ? (
                    sortReleaseAssets(release.assets).map((asset) => (
                      <a
                        key={asset.name}
                        className={styles.asset}
                        href={asset.browser_download_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        download
                      >
                        <span>{formatAssetLabel(asset.name)}</span>
                        <small>{formatBytes(asset.size)} ↓</small>
                      </a>
                    ))
                  ) : (
                    <a
                      className={styles.asset}
                      href={release.html_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span>查看该版本附件</span>
                      <small>GitHub ↗</small>
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
