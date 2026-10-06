"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, KeyRound, Mail, ShieldCheck } from "lucide-react";
import { Button as MotionButton } from "@/components/motion/button/base";
import { accountErrorText, accountRequest, safeReturnTo, type GeoDAccount, type VerificationInfo } from "@/lib/account";
import { notifyAccountChanged } from "@/lib/account-events";
import styles from "../account.module.css";
import { trackProductEvent } from "@/lib/product-analytics";

type Mode = "login" | "register" | "reset";

export default function AccountLogin() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<GeoDAccount | null>(null);
  const [checking, setChecking] = useState(true);
  const [emailAvailable, setEmailAvailable] = useState<boolean | null>(null);
  const inFlight = useRef(false);
  const destination = typeof window === "undefined" ? "/dashboard" : safeReturnTo(window.location.search);

  useEffect(() => {
    const initialMode = new URLSearchParams(window.location.search).get("mode");
    if (initialMode === "register" || initialMode === "reset") setMode(initialMode);
    let active = true;
    void Promise.allSettled([accountRequest<GeoDAccount>("/api/account"), accountRequest<VerificationInfo>("/api/account/verification")]).then(([account, verification]) => {
      if (!active) return;
      if (account.status === "fulfilled") setSession(account.value);
      else setError(accountErrorText(account.reason));
      setEmailAvailable(verification.status === "fulfilled" ? verification.value.channels.email : false);
      setChecking(false);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(() => setCooldown(value => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  function changeMode(next: Mode) {
    setMode(next); setPassword(""); setConfirmation(""); setCode(""); setChallengeId(""); setError(""); setNotice("");
  }
  async function run(operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { await operation(); }
    catch (reason) { setError(accountErrorText(reason)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async () => {
      void trackProductEvent("account_login_submitted");
      await accountRequest("/api/account/login", "POST", { email: email.trim(), password });
      const next = await accountRequest<GeoDAccount>("/api/account");
      if (!next.user) throw new Error("Session not established");
      notifyAccountChanged();
      void trackProductEvent("account_login_succeeded");
      setPassword(""); window.location.assign(destination);
    });
  }
  async function sendCode() {
    if (!email.trim() || cooldown || !emailAvailable) return;
    await run(async () => {
      setCooldown(60); setNotice(""); setCode("");
      const requestId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : undefined;
      const value = await accountRequest<{ challengeId: string; retryAfter: number; delivery: string }>("/api/account/verification", "POST", { channel: "email", target: email.trim(), purpose: mode, requestId });
      setChallengeId(value.challengeId); setCooldown(value.retryAfter);
      setNotice(value.delivery === "accepted" ? "发送请求已受理。请查看邮箱，验证码 5 分钟内有效。" : "发送状态未确认；如果收到了验证码，可以继续验证。");
    });
  }
  async function completeVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challengeId || code.length !== 6) return;
    if (password !== confirmation) { setError("两次密码不一致，请重新输入。"); return; }
    await run(async () => {
      if (mode === "register") void trackProductEvent("account_registration_submitted");
      await accountRequest("/api/account/verification", "PUT", { channel: "email", target: email.trim(), purpose: mode, challengeId, code, password });
      const next = await accountRequest<GeoDAccount>("/api/account");
      if (!next.user) throw new Error("Session not established");
      notifyAccountChanged();
      void trackProductEvent(mode === "register" ? "account_registration_succeeded" : "account_password_reset_succeeded");
      setPassword(""); setConfirmation(""); setCode(""); window.location.assign(destination);
    });
  }

  return <main className={styles.page}>
    <div className={styles.authLayout}>
      <section className={styles.intro} aria-labelledby="account-intro">
        <span className={styles.eyebrow}>GEOD ACCOUNT</span>
        <h1 id="account-intro">一个 GeoD 账号，<br />进入你的工作台。</h1>
        <p>管理自己的 GeoD 身份，接入浏览器影像、CLI、MCP 与地图创作。下载 0–5 级瓦片无需登录；更高级别由你自己授权。</p>
        <div className={styles.introList}>
          <div><ShieldCheck size={18} aria-hidden="true" /><span>授权在你的浏览器完成，Agent 不接触密码。</span></div>
          <div><KeyRound size={18} aria-hidden="true" /><span>登录后返回刚才的页面，继续当前任务。</span></div>
        </div>
      </section>
      <section className={styles.authCard} aria-labelledby="auth-title">
        {checking ? <p role="status" className={styles.muted}>正在确认登录状态…</p> : session?.user ? <>
          <span className={styles.eyebrow}>SIGNED IN</span>
          <h2 id="auth-title">已经登录 GeoD</h2>
          <p className={styles.muted}>{session.user.email}</p>
          <div className={styles.signedInActions}>
            {destination !== "/dashboard" && <a className={styles.primary} href={destination}>继续前往 <ArrowRight size={17} aria-hidden="true" /></a>}
            <Link className={destination === "/dashboard" ? styles.primary : styles.textLink} href="/dashboard">进入个人控制台{destination === "/dashboard" && <ArrowRight size={17} aria-hidden="true" />}</Link>
          </div>
        </> : <>
          <span className={styles.eyebrow}>{mode === "login" ? "WELCOME BACK" : mode === "register" ? "CREATE ACCOUNT" : "RESET PASSWORD"}</span>
          <h2 id="auth-title">{mode === "login" ? "登录 GeoD" : mode === "register" ? "注册 GeoD" : "找回密码"}</h2>
          <p className={styles.muted}>{mode === "login" ? "使用 GeoD 账号继续。" : mode === "register" ? "验证邮箱即可创建 GeoD 账号，无需邀请码。" : "验证账号邮箱后设置新密码。"}</p>
          {mode === "login" ? <form className={styles.form} onSubmit={event => void signIn(event)}>
            <label htmlFor="geod-email">邮箱</label><input id="geod-email" type="email" autoComplete="username" maxLength={254} required disabled={busy} value={email} onChange={event => setEmail(event.target.value)} />
            <label htmlFor="geod-password">密码</label><input id="geod-password" type="password" autoComplete="current-password" maxLength={128} required disabled={busy} value={password} onChange={event => setPassword(event.target.value)} />
            <MotionButton className={styles.primary} type="submit" disabled={busy}>{busy ? "正在登录…" : "登录并继续"}<ArrowRight size={17} aria-hidden="true" /></MotionButton>
          </form> : <form className={styles.form} onSubmit={event => void completeVerification(event)}>
            {emailAvailable === false && <p className={styles.formError} role="status">邮箱验证暂不可用，请稍后重试。</p>}
            <label htmlFor="verify-email">邮箱</label><input id="verify-email" type="email" autoComplete="email" maxLength={254} required disabled={busy} value={email} onChange={event => { setEmail(event.target.value); setCode(""); setChallengeId(""); setNotice(""); }} />
            <MotionButton variant="secondary" className={styles.secondary} type="button" disabled={busy || !emailAvailable || !email.trim() || cooldown > 0} onClick={() => void sendCode()}><Mail size={16} aria-hidden="true" />{cooldown ? `${cooldown} 秒后可重发` : "发送邮箱验证码"}</MotionButton>
            <label htmlFor="verify-code">验证码</label><input id="verify-code" type="text" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required disabled={busy} value={code} onChange={event => setCode(event.target.value)} />
            <label htmlFor="new-password">{mode === "reset" ? "新密码" : "设置密码"}</label><input id="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy} value={password} onChange={event => setPassword(event.target.value)} />
            <span className={styles.hint}>当前账号服务要求 12–128 个字符。</span>
            <label htmlFor="confirm-password">确认密码</label><input id="confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} />
            <MotionButton className={styles.primary} type="submit" disabled={busy || !emailAvailable || !challengeId || code.length !== 6}>{busy ? "正在验证…" : mode === "register" ? "注册并登录" : "保存密码并登录"}<ArrowRight size={17} aria-hidden="true" /></MotionButton>
          </form>}
          {notice && <p className={styles.notice} role="status">{notice}</p>}
          {error && <p className={styles.formError} role="alert">{error}{challengeId && <small> 排查编号：{challengeId}</small>}</p>}
          <div className={styles.switches}>
            {mode !== "login" ? <button type="button" disabled={busy} onClick={() => changeMode("login")}>返回登录</button> : <><button type="button" disabled={busy} onClick={() => changeMode("register")}>注册账号</button><button type="button" disabled={busy} onClick={() => changeMode("reset")}>忘记密码？</button></>}
          </div>
          <p className={styles.hint}>接入遇到问题，或想参与后续功能测试？<Link className={styles.textLink} href="/apply?from=%2Flogin">提交接入问题或登记测试意向</Link>。注册账号无需先提交申请。</p>
        </>}
      </section>
    </div>
  </main>;
}
