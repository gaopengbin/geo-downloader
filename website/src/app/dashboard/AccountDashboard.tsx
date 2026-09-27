"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, LogOut, RefreshCw } from "lucide-react";
import { Button as MotionButton } from "@/components/motion/button/base";
import { accountErrorText, accountRequest, type AccountSession, type GeoDAccount } from "@/lib/account";
import AvatarSettings from "./AvatarSettings";
import styles from "../account.module.css";
import { trackProductEvent } from "@/lib/product-analytics";

const products = [
  { name: "浏览器影像", description: "在当前设备下载、拼接与裁剪影像。", href: "/browser" },
  { name: "GeoD 桌面端", description: "下载与处理完整空间数据。", href: "/#download" },
  { name: "GeoD CLI", description: "在本机终端运行影像任务。", href: "/cli" },
  { name: "GeoD MCP", description: "把 GeoD 能力接入你的 Agent。", href: "/mcp" },
  { name: "GeoD 地图创作", description: "进入地图创作工作台；创作积分在该产品中使用。", href: "/geod" },
];

export default function AccountDashboard() {
  const [account, setAccount] = useState<GeoDAccount | null>(null);
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [securityNotice, setSecurityNotice] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const value = await accountRequest<GeoDAccount>("/api/account");
      setAccount(value);
      if (value.user) {
        try { setSessions((await accountRequest<{ sessions: AccountSession[] }>("/api/account/sessions")).sessions); }
        catch { setSessions([]); }
      } else setSessions([]);
    } catch (reason) {
      setError(accountErrorText(reason));
    }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function logout() {
    setBusy(true); setError("");
    try {
      await accountRequest("/api/account/logout", "POST", {});
      void trackProductEvent("account_logout_succeeded");
      setAccount({ user: null, authRequired: true }); setSessions([]);
      window.location.assign("/login");
    } catch (reason) { setError(accountErrorText(reason)); }
    finally { setBusy(false); }
  }
  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setSecurityNotice("");
    if (newPassword !== confirmPassword) { setError("两次新密码不一致，请重新输入。"); return; }
    setBusy(true);
    try {
      await accountRequest("/api/account/password", "POST", { currentPassword, newPassword });
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      setSecurityNotice("密码已更新，其他设备的登录会话已退出。");
      await load();
    } catch (reason) { setError(accountErrorText(reason)); }
    finally { setBusy(false); }
  }

  return <main className={styles.page}><div className={styles.dashboard}>
    <header className={styles.dashboardHead}>
      <div><span className={styles.eyebrow}>MY GEOD</span><h1>个人控制台</h1><p>账号、安全与 GeoD 产品入口。</p></div>
      <MotionButton variant="secondary" className={styles.secondary} type="button" onClick={() => void load()} disabled={loading || busy}><RefreshCw size={16} aria-hidden="true" />刷新状态</MotionButton>
    </header>
    {error && <p className={styles.formError} role="alert">{error}</p>}
    {loading && !account ? <section className={styles.panel} role="status">正在读取账号…</section> : !account?.user ? <section className={styles.panel}>
      <h2>登录后进入你的控制台</h2><p>使用 GeoD 账号查看身份、登录会话和地图创作额度。浏览器影像 0–5 级下载仍可匿名使用。</p>
      <Link className={styles.primary} href="/login?returnTo=%2Fdashboard">登录或注册 GeoD <ArrowRight size={17} aria-hidden="true" /></Link>
    </section> : <>
      <div className={styles.dashboardGrid}>
        <section className={styles.panel} aria-labelledby="identity-heading">
          <h2 id="identity-heading">我的账号</h2>
          <p className={styles.identity}>{account.user.email}</p>
          <span className={styles.status}>{account.user.emailVerifiedAt ? "邮箱已验证" : "账号已登录"}</span>
          <p className={styles.subtle}>加入时间：{new Date(account.user.createdAt).toLocaleDateString("zh-CN")}</p>
          <div className={styles.actionRow}><MotionButton variant="secondary" className={styles.secondary} type="button" disabled={busy} onClick={() => void logout()}><LogOut size={16} aria-hidden="true" />退出登录</MotionButton></div>
        </section>
        <section className={styles.panel} aria-labelledby="usage-heading">
          <h2 id="usage-heading">地图创作额度</h2>
          {account.quota ? <><p className={styles.identity}>{account.quota.remaining} 点可用</p><p>这项额度属于 GeoD 地图创作。CLI、MCP 和浏览器下载目前不消耗这里的创作积分。</p></> : <p>暂时无法读取地图创作额度，请稍后刷新。</p>}
          <Link className={styles.textLink} href="/geod">前往地图创作工作台 →</Link>
        </section>
      </div>
      <AvatarSettings user={account.user} onChange={user => setAccount(current => current ? { ...current, user } : current)} />
      <section className={styles.productSection} aria-labelledby="product-heading"><h2 id="product-heading">进入 GeoD 产品</h2><div className={styles.productGrid}>{products.map(product => <Link key={product.name} className={styles.tile} href={product.href}><strong>{product.name} ↗</strong><span>{product.description}</span></Link>)}</div></section>
      <section className={`${styles.panel} ${styles.productSection}`} aria-labelledby="security-heading"><h2 id="security-heading">登录安全</h2><p>修改密码后，其他设备的登录会话会退出；当前设备保持登录。</p><p className={styles.subtle}>{sessions.length ? `当前账号有 ${sessions.length} 个有效会话。` : "会话列表暂未载入。"}</p>
        <form className={styles.form} onSubmit={event => void updatePassword(event)}>
          <label htmlFor="current-password">当前密码</label><input id="current-password" type="password" autoComplete="current-password" required maxLength={128} disabled={busy} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} />
          <label htmlFor="new-account-password">新密码</label><input id="new-account-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy} value={newPassword} onChange={event => setNewPassword(event.target.value)} />
          <label htmlFor="confirm-account-password">确认新密码</label><input id="confirm-account-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} />
          <MotionButton variant="secondary" className={styles.secondary} type="submit" disabled={busy}>{busy ? "正在更新…" : "更新密码"}</MotionButton>
        </form>{securityNotice && <p className={styles.notice} role="status">{securityNotice}</p>}
      </section>
    </>}
  </div></main>;
}
