"use client";

import { useState } from "react";
import styles from "./tools.module.css";

export default function CopyText({ text, label = "复制" }: { text: string; label?: string }) {
  const [status, setStatus] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("已复制");
    } catch {
      setStatus("复制失败，请手动选择文本");
    }
  }

  return (
    <span className={styles.copyControl}>
      <button className={styles.copyButton} type="button" onClick={copy}>
        {label}
      </button>
      <span className={styles.copyStatus} role="status" aria-live="polite">{status}</span>
    </span>
  );
}
