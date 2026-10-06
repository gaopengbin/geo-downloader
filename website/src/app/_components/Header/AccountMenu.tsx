"use client";

import { useEffect, useRef, useState } from "react";
import { LogOut, LayoutDashboard } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { accountErrorText, accountRequest, type GeoDAccount } from "@/lib/account";
import { notifyAccountChanged } from "@/lib/account-events";
import Avatar from "../Avatar";
import styles from "./styles.module.css";

type AccountUser = NonNullable<GeoDAccount["user"]>;

export default function AccountMenu({ user, onLoggedOut, alignToTrigger = false }: { user: AccountUser; onLoggedOut: () => void; alignToTrigger?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  async function logout() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await accountRequest("/api/account/logout", "POST", {});
      notifyAccountChanged();
      setOpen(false);
      onLoggedOut();
      window.location.assign("/login");
    } catch (reason) {
      setError(accountErrorText(reason));
      setBusy(false);
    }
  }

  return <div className={styles.accountMenu} ref={rootRef}>
    <Button
      ref={triggerRef}
      variant="ghost"
      size="icon"
      className={styles.avatarButton}
      type="button"
      aria-label="打开账号菜单"
      aria-expanded={open}
      aria-controls="geod-account-menu"
      onClick={() => setOpen(value => !value)}
    >
      <Avatar user={user} size={34} />
    </Button>
    {open && <div id="geod-account-menu" className={`${styles.accountPanel} ${alignToTrigger ? styles.alignedAccountPanel : ""}`}>
      <div className={styles.accountIdentity}>
        <Avatar user={user} size={42} />
        <div><strong>GeoD 账号</strong><span title={user.email}>{user.email}</span></div>
      </div>
      <div className={styles.accountActions}>
        <a href="/dashboard" onClick={() => setOpen(false)}><LayoutDashboard size={17} aria-hidden="true" />个人控制台</a>
        <Button variant="ghost" className={styles.logoutAction} type="button" disabled={busy} onClick={() => void logout()}><LogOut size={17} aria-hidden="true" />{busy ? "正在退出…" : "退出登录"}</Button>
      </div>
      {error && <p className={styles.accountError} role="alert">{error}</p>}
    </div>}
  </div>;
}
