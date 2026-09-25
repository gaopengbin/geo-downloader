import CopyText from "./CopyText";
import styles from "./tools.module.css";

export default function CodeBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <span>{label}</span>
        <CopyText text={text} label="复制" />
      </div>
      <pre><code>{text}</code></pre>
    </div>
  );
}
