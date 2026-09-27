"use client";

import { useState } from "react";
import { trackProductEvent } from "@/lib/product-analytics";
import { Button as MotionButton } from "@/components/motion/button/base";
import styles from "./tools.module.css";

export default function CopyText({ text, label = "复制", trackInstall = false }: { text: string; label?: string; trackInstall?: boolean }) {
  const [status, setStatus] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      if (trackInstall) void trackProductEvent("install_instructions_copied");
      setStatus("已复制");
    } catch {
      setStatus("复制失败，请手动选择文本");
    }
  }

  return (
    <span className={styles.copyControl}>
      <MotionButton variant="outline" size="sm" className={styles.copyButton} type="button" onClick={copy}>
        {label}
      </MotionButton>
      <span className={styles.copyStatus} role="status" aria-live="polite">{status}</span>
    </span>
  );
}
