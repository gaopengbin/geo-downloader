"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { ImagePlus, RotateCcw } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import Avatar, { PresetAvatar } from "../_components/Avatar";
import { AccountError, accountErrorText, accountRequest, type GeoDAccount } from "@/lib/account";
import { avatarPresets, defaultAvatarPreset } from "@/lib/avatars";
import styles from "./avatar-settings.module.css";

type User = NonNullable<GeoDAccount["user"]>;
const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

export default function AvatarSettings({ user, onChange }: { user: User; onChange: (user: User) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const currentPreset = user.avatar?.kind === "preset" ? user.avatar.id : user.avatar?.kind === "upload" ? null : defaultAvatarPreset(user.id).id;

  function applyChange(next: User, message: string) {
    onChange(next);
    setNotice(message);
    window.dispatchEvent(new Event("geod:account-updated"));
  }

  async function selectPreset(id: string) {
    if (busy || (user.avatar?.kind === "preset" && user.avatar.id === id)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await accountRequest<{ user: User }>("/api/account/avatar", "PUT", { presetId: id });
      applyChange(result.user, "默认头像已保存。");
    } catch (reason) { setError(accountErrorText(reason)); }
    finally { setBusy(false); }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busy) return;
    if (!allowedTypes.has(file.type)) { setError("请选择 JPG、PNG、WebP 或 AVIF 图片。"); return; }
    if (file.size > 5 * 1024 * 1024) { setError("图片不能超过 5 MB。"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/account/avatar", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": file.type }, body: file });
      const value: { user?: User; error?: { code?: string; message?: string } } | null = await response.json().catch(() => null);
      if (!response.ok || !value?.user) throw new AccountError(value?.error?.code ?? "ACCOUNT_UNAVAILABLE", value?.error?.message ?? "Avatar upload failed");
      applyChange(value.user, "头像已上传，图片已自动裁成正方形。");
    } catch (reason) { setError(accountErrorText(reason)); }
    finally { setBusy(false); }
  }

  async function reset() {
    if (busy || !user.avatar) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await accountRequest<{ user: User }>("/api/account/avatar", "DELETE", {});
      applyChange(result.user, "已恢复系统分配的默认头像。");
    } catch (reason) { setError(accountErrorText(reason)); }
    finally { setBusy(false); }
  }

  return <section className={styles.panel} aria-labelledby="avatar-heading">
    <div className={styles.heading}>
      <div><h2 id="avatar-heading">我的头像</h2><p>选择一款 GeoD 默认头像，或上传自己的照片。头像会跟随账号保存。</p></div>
      <Avatar user={user} size={76} className={styles.currentAvatar} />
    </div>
    <div className={styles.presets} role="group" aria-label="选择默认头像">
      {avatarPresets.map(preset => <button key={preset.id} className={styles.preset} type="button" aria-label={preset.name} aria-pressed={currentPreset === preset.id} disabled={busy} onClick={() => void selectPreset(preset.id)}>
        <PresetAvatar id={preset.id} size={52} /><span>{preset.name}</span>
      </button>)}
    </div>
    <div className={styles.actions}>
      <input className={styles.fileInput} ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/avif" onChange={event => void upload(event)} aria-label="选择头像图片" />
      <Button variant="secondary" type="button" disabled={busy} onClick={() => inputRef.current?.click()}><ImagePlus size={17} aria-hidden="true" />{busy ? "正在保存…" : "上传头像"}</Button>
      {user.avatar && <Button variant="ghost" type="button" disabled={busy} onClick={() => void reset()}><RotateCcw size={16} aria-hidden="true" />恢复系统默认</Button>}
      <span>支持 JPG、PNG、WebP、AVIF，最大 5 MB</span>
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
  </section>;
}
