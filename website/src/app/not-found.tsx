import Link from "next/link";

import Background from "./_components/Background";
import Footer from "./_components/Footer";
import Header from "./_components/Header";
import styles from "./geod-page.module.css";

export default function NotFound() {
  return (
    <>
      <Background sticky />
      <Header />
      <main className={styles.page}>
        <div className={styles.container}>
          <section className={styles.head}>
            <span className={styles.eyebrow}>404 / Not Found</span>
            <h1 className={styles.title}>这个页面不存在</h1>
            <p className={styles.lead}>
              链接可能已经失效，或者页面已被移动。你可以返回首页继续查看 GeoD。
            </p>
            <div className={styles.toolbar}>
              <Link href="/">返回首页</Link>
              <Link href="/#download">下载 GeoD</Link>
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
