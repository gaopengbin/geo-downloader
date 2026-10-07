import type { ReactNode } from "react";
import styles from "./styles.module.css";

/** Decorative Earth artwork; product screenshots retain their original appearance. */
export default function SpacePage({ children }: { children: ReactNode }) {
  return (
    <div className={styles.page} data-site-theme="space">
      <div className={styles.backdrop} aria-hidden="true">
        <img src="/geod-site/earth-horizon-20261008.png" alt="" width={1536} height={1024} fetchPriority="high" decoding="async" />
      </div>
      {children}
    </div>
  );
}
