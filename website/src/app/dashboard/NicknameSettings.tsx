"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/motion/button/base";
import { AccountError, accountErrorText, accountRequest, type GeoDAccount } from "@/lib/account";
import { notifyAccountChanged } from "@/lib/account-events";
import { LocalizedContent } from "@/app/_components/LocaleProvider";
import styles from "./dashboard.module.css";

type User = NonNullable<GeoDAccount["user"]>;

export default function NicknameSettings({ user, onChange }: { user: User; onChange: (user: User) => void }) {
  const saved = user.nickname ?? "";
  const previous = useRef(saved);
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const normalized = draft.trim();
  const invalid = Array.from(normalized).length > 40 || /[\u0000-\u001f\u007f-\u009f]/.test(draft);
  useEffect(() => {
    const old = previous.current;
    setDraft(current => current === old ? saved : current);
    previous.current = saved;
  }, [saved]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || invalid || normalized === saved) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await accountRequest<{ user: User }>("/api/account", "PATCH", { nickname: normalized });
      if (result.user.id !== user.id) throw new AccountError("AUTH_REQUIRED", "Account changed");
      onChange(result.user);
      setDraft(result.user.nickname ?? "");
      setNotice(normalized ? "昵称已保存，GeoD Agent 会在同步账号时更新。" : "已恢复默认昵称，GeoD Agent 会在同步账号时更新。");
      notifyAccountChanged();
    } catch (reason) { setError(accountErrorText(reason)); }
    finally { setBusy(false); }
  }

  return <LocalizedContent><section className={`${styles.card} ${styles.nicknameCard}`} aria-labelledby="nickname-heading">
    <div className={styles.cardHeading}><h2 id="nickname-heading">我的昵称</h2></div>
    <p className={styles.cardDescription}>用于官网和 GeoD Agent 的账号显示。</p>
    <form className={`${styles.form} ${styles.nicknameForm}`} onSubmit={event => void save(event)}>
      <div className={styles.field}>
        <label htmlFor="account-nickname">昵称</label>
        <input id="account-nickname" name="nickname" autoComplete="nickname" placeholder="设置你的昵称" value={draft} disabled={busy} aria-invalid={invalid || undefined} aria-describedby="nickname-help" onChange={event => { setDraft(event.target.value); setError(""); setNotice(""); }} />
        <span id="nickname-help" className={styles.fieldHint}>{invalid ? "昵称不能超过 40 个字符，且不能包含换行。" : "最多 40 个字符；留空将生成 geod 开头的默认昵称。"}</span>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      <Button type="submit" className={styles.saveButton} disabled={busy || invalid || normalized === saved}>{busy ? "正在保存…" : "保存昵称"}</Button>
    </form>
  </section></LocalizedContent>;
}
