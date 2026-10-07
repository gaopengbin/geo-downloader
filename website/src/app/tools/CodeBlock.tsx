"use client";
import { LocalizedContent, useLocale } from "@/app/_components/LocaleProvider";
import { localizedExample } from "@/lib/i18n";
import CopyText from "./CopyText";
import styles from "./tools.module.css";

export default function CodeBlock({ text, label, trackInstall = false }: { text: string; label: string; trackInstall?: boolean }) {
  const example = localizedExample(text, useLocale());
  return (
    <LocalizedContent><div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <span>{label}</span>
        <CopyText text={example} label="复制" trackInstall={trackInstall} />
      </div>
      <pre><code>{example}</code></pre>
    </div></LocalizedContent>
  );
}
