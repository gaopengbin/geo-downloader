import CopyText from "./CopyText";
import styles from "./tools.module.css";

export default function CodeBlock({ text, label, trackInstall = false }: { text: string; label: string; trackInstall?: boolean }) {
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <span>{label}</span>
        <CopyText text={text} label="复制" trackInstall={trackInstall} />
      </div>
      <pre><code>{text}</code></pre>
    </div>
  );
}
