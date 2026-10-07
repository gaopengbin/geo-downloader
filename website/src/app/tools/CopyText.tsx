"use client";
import { LocalizedContent, useLocale } from "@/app/_components/LocaleProvider";
import { translate } from "@/lib/i18n";

import { useState } from "react";
import { trackProductEvent } from "@/lib/product-analytics";
import { Button as MotionButton } from "@/components/motion/button/base";
import styles from "./tools.module.css";

export default function CopyText({ text, label = "复制", trackInstall = false }: { text: string; label?: string; trackInstall?: boolean }) {
  const locale = useLocale();
  const [status, setStatus] = useState("");

  async function copy() {
    try {
      // Translate natural-language connection prompts; preserve commands and JSON.
      await navigator.clipboard.writeText(text.startsWith("请从 ") ? translate(text, locale) : text);
      if (trackInstall) void trackProductEvent("install_instructions_copied");
      setStatus("已复制");
    } catch {
      setStatus("复制失败，请手动选择文本");
    }
  }

  return (
    <LocalizedContent><span className={styles.copyControl}>
      <MotionButton variant="outline" size="sm" className={styles.copyButton} type="button" onClick={copy}>
        {label}
      </MotionButton>
      <span className={styles.copyStatus} role="status" aria-live="polite">{status}</span>
    </span></LocalizedContent>
  );
}
