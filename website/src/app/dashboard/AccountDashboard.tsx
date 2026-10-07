"use client";
import { LocalizedContent, LanguageSwitch, useLocale } from "@/app/_components/LocaleProvider";
import { localePath, type Locale } from "@/lib/i18n";


import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronRight, Globe2,
  LayoutDashboard, Layers3, LogOut, Monitor, MonitorCheck, Package,
  Plug, RefreshCw, ShieldCheck, Sparkles, Terminal, UserRound,
  ClipboardList, KeyRound, Mail,
} from "lucide-react";
import { MessageSquare } from "lucide-react";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { accountErrorText, accountRequest, type AccountSession, type GeoDAccount } from "@/lib/account";
import { notifyAccountChanged, subscribeAccountChanges } from "@/lib/account-events";
import { MAP_CREATION_VISIBLE, MAP_WORKSPACE_URL } from "@/lib/site";
import { trackProductEvent } from "@/lib/product-analytics";
import Avatar from "../_components/Avatar";
import Logo from "../_components/Logo";
import AccountMenu from "../_components/Header/AccountMenu";
import AvatarSettings from "./AvatarSettings";
import NicknameSettings from "./NicknameSettings";
import styles from "./dashboard.module.css";

const navigation = [
  { id: "overview", label: "工作台总览", icon: LayoutDashboard, description: "选择产品开始工作，管理你的 GeoD 账号。" },
  { id: "products", label: "我的产品", icon: Package, description: "在浏览器、桌面或 Agent 中，使用适合你的 GeoD 工具。" },
  { id: "profile", label: "个人资料", icon: UserRound, description: "查看账号信息，设置在 GeoD 中显示的头像和昵称。" },
  { id: "security", label: "账号安全", icon: ShieldCheck, description: "管理登录密码，查看当前账号的有效会话。" },
] as const;
type Section = typeof navigation[number]["id"];

const products = ([
  { id: "agent", name: "GeoD Agent", description: "用对话组织地理数据任务，在本机规划、下载与核验成果。", href: "/agent", icon: MessageSquare, tag: "独立桌面应用", action: "了解与下载 Agent", color: "blue" },
  { id: "browser", name: "浏览器影像", description: "在当前设备下载、拼接与裁剪影像，无需安装。", href: "/browser", icon: Globe2, tag: "浏览器", action: "打开浏览器版", color: "blue" },
  { id: "geod", name: "地图创作", description: "在新窗口打开创作工作台，复用当前 GeoD 登录状态。", href: MAP_WORKSPACE_URL, icon: Layers3, tag: "创作工具", action: "进入工作台", color: "purple" },
  { id: "mcp", name: "GeoD MCP", description: "向你的 Agent 提供 GeoD 规划、下载和成果读取工具。", href: "/mcp", icon: Plug, tag: "Agent 接入", action: "查看接入方式", color: "teal" },
  { id: "desktop", name: "GeoD 桌面端", description: "下载与处理空间数据，使用完整的桌面工作流。", href: "/#download", icon: Monitor, tag: "桌面应用", action: "下载桌面端", color: "blue" },
  { id: "cli", name: "GeoD CLI", description: "在本机终端运行影像任务，接入脚本与自动化工作流。", href: "/cli", icon: Terminal, tag: "命令行", action: "查看安装说明", color: "slate" },
] as const).filter(product => MAP_CREATION_VISIBLE || product.id !== "geod");

function formatDate(value: string, withTime = false, locale: Locale = "zh") {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "暂不可用";
  return date.toLocaleDateString(locale === "en" ? "en-US" : "zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) });
}

export default function AccountDashboard() {
  const locale = useLocale();
  const dateLabel = (value: string, withTime = false) => formatDate(value, withTime, locale);
  const [section, setSection] = useState<Section>("overview");
  const [account, setAccount] = useState<GeoDAccount | null>(null);
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [sessionsError, setSessionsError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [securityError, setSecurityError] = useState("");
  const [securityNotice, setSecurityNotice] = useState("");
  const loadVersion = useRef(0);
  const currentSection = navigation.find(item => item.id === section)!;
  const user = account?.user;
  const loginHref = `${localePath("/login", locale)}?returnTo=${encodeURIComponent(localePath(`/dashboard#${section}`, locale))}`;

  useEffect(() => {
    const syncSection = () => {
      const id = window.location.hash.slice(1);
      if (navigation.some(item => item.id === id)) setSection(id as Section);
      else if (!id) setSection("overview");
    };
    syncSection();
    window.addEventListener("hashchange", syncSection);
    return () => window.removeEventListener("hashchange", syncSection);
  }, []);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true); setError(""); setSessionsError("");
    try {
      const value = await accountRequest<GeoDAccount>("/api/account");
      if (version !== loadVersion.current) return;
      setAccount(value);
      if (value.user) {
        try {
          const result = await accountRequest<{ sessions: AccountSession[] }>("/api/account/sessions");
          if (version === loadVersion.current) setSessions(result.sessions);
        }
        catch (reason) { if (version === loadVersion.current) { setSessions(null); setSessionsError(accountErrorText(reason)); } }
      } else setSessions(null);
    } catch (reason) { if (version === loadVersion.current) setError(accountErrorText(reason)); }
    finally { if (version === loadVersion.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => void load();
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    const unsubscribe = subscribeAccountChanges(refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => { ++loadVersion.current; unsubscribe(); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [load]);
  useEffect(() => {
    if (section !== "security") {
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); setSecurityError("");
    }
  }, [section]);

  async function logout() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await accountRequest("/api/account/logout", "POST", {});
      notifyAccountChanged();
      void trackProductEvent("account_logout_succeeded");
      setAccount({ user: null, authRequired: true }); setSessions(null);
      window.location.assign(localePath("/login", locale));
    } catch (reason) { setError(accountErrorText(reason)); }
    finally { setBusy(false); }
  }

  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setSecurityError(""); setSecurityNotice("");
    if (newPassword !== confirmPassword) { setSecurityError("两次新密码不一致，请重新输入。"); return; }
    setBusy(true);
    try {
      await accountRequest("/api/account/password", "POST", { currentPassword, newPassword });
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      setSecurityNotice("密码已更新，其他设备的登录会话已退出。当前设备保持登录。");
      await load();
    } catch (reason) { setSecurityError(accountErrorText(reason)); }
    finally { setBusy(false); }
  }

  return <LocalizedContent><div className={styles.console}>
    <a className={styles.skipLink} href="#console-content">跳转到主要内容</a>
    <header className={styles.topbar}>
      <a className={styles.brand} href="/" aria-label="GeoD 官网"><Logo height={27} /><span>控制台</span></a>
      <div className={styles.topbarActions}>
        <LanguageSwitch />
        <ButtonLink href="/" variant="ghost" size="sm" className={styles.homeLink}>返回官网<ArrowUpRight size={15} aria-hidden="true" /></ButtonLink>
        {user ? <AccountMenu user={user} alignToTrigger onLoggedOut={() => { void trackProductEvent("account_logout_succeeded"); setAccount({ user: null, authRequired: true }); setSessions(null); }} /> : loading && !account ? <span className={styles.authPlaceholder} aria-hidden="true" /> : <ButtonLink href={loginHref} size="sm">登录 / 注册</ButtonLink>}
      </div>
    </header>

    <div className={styles.workspace}>
      <aside className={styles.sidebar} aria-label="控制台侧栏">
        <div className={styles.sidebarLabel}>个人工作空间</div>
        <nav className={styles.navigation} aria-label="控制台导航">
          {navigation.map(item => <ButtonLink key={item.id} href={`/dashboard#${item.id}`} variant="ghost" className={`${styles.navLink} ${section === item.id ? styles.navActive : ""}`} aria-current={section === item.id ? "page" : undefined}>
            <item.icon size={19} strokeWidth={1.8} aria-hidden="true" /><span>{item.label}</span>
          </ButtonLink>)}
        </nav>
        {account?.permissions?.billingAdmin && <div className={styles.adminNavigation}>
          <div className={styles.sidebarLabel}>管理</div>
          <ButtonLink href="/admin/applications" variant="ghost" className={styles.navLink}><ClipboardList size={19} strokeWidth={1.8} aria-hidden="true" /><span>申请管理</span><ArrowUpRight size={14} className={styles.navTrailing} aria-hidden="true" /></ButtonLink>
        </div>}
        <div className={styles.sidebarFooter}>
          <div className={styles.workspaceNote}><ShieldCheck size={17} aria-hidden="true" /><span>一个账号，连接 GeoD 产品</span></div>
          {user && <>
            <div className={styles.sidebarIdentity}><Avatar user={user} size={32} /><div data-no-translate><strong title={user.nickname}>{user.nickname || "GeoD 账号"}</strong><span title={user.email}>{user.email}</span></div></div>
            <Button variant="ghost" className={styles.logout} size="sm" disabled={busy} onClick={() => void logout()}><LogOut size={16} aria-hidden="true" />{busy ? "正在处理…" : "退出登录"}</Button>
          </>}
        </div>
      </aside>

      <main id="console-content" className={styles.main} tabIndex={-1}>
        <div className={styles.content}>
          <div className={styles.breadcrumb}><span>我的 GeoD</span><ChevronRight size={14} aria-hidden="true" /><span>{currentSection.label}</span></div>
          <header className={styles.pageHead}>
            <div><h1>{currentSection.label}</h1><p>{currentSection.description}</p></div>
            <Button variant="secondary" size="sm" className={styles.refreshButton} onClick={() => void load()} disabled={loading || busy}><RefreshCw size={15} className={loading ? styles.spinning : ""} aria-hidden="true" /><span>{loading ? "正在刷新" : "刷新状态"}</span></Button>
          </header>
          {error && <p className={styles.error} role="alert">{error}{account?.user && " 当前显示上次读取的信息，可刷新重试。"}</p>}
          {loading && !account ? <section className={`${styles.card} ${styles.emptyState}`} role="status"><RefreshCw size={24} className={styles.spinning} aria-hidden="true" /><h2>正在读取你的工作空间</h2><p>账号与产品信息加载中。</p></section>
            : !user ? <section className={`${styles.card} ${styles.emptyState}`}>
              <div className={styles.emptyIcon}><UserRound size={27} aria-hidden="true" /></div>
              <h2>{error ? "暂时无法读取账号" : "登录后进入你的控制台"}</h2>
              <p>{error ? "请刷新重试，或重新登录 GeoD。" : "查看账号、设置头像与管理登录安全。浏览器影像 0–5 级下载可直接使用。"}</p>
              <ButtonLink href={loginHref}>登录 / 注册<ArrowRight size={16} aria-hidden="true" /></ButtonLink>
              {error && <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>重新加载</Button>}
            </section>
            : <div key={section} className={styles.sectionContent} aria-busy={loading}>
              {section === "overview" && <>
                <section className={styles.welcome} aria-labelledby="welcome-heading">
                  <div className={styles.welcomeIdentity}><Avatar user={user} size={48} /><div><h2 id="welcome-heading">欢迎回来</h2><p data-no-translate>{user.email}</p></div></div>
                  <ButtonLink href="/browser" className={styles.primaryAction}>开始影像下载<ArrowUpRight size={16} aria-hidden="true" /></ButtonLink>
                </section>
                <div className={`${styles.metrics} ${!MAP_CREATION_VISIBLE ? styles.metricsWithoutCreation : ""}`}>
                  {MAP_CREATION_VISIBLE && <section className={styles.metric}><div className={styles.metricLabel}><Sparkles size={17} aria-hidden="true" /><span>地图创作积分</span></div><p className={styles.metricValue}>{account?.quota ? <>{account.quota.remaining.toLocaleString("zh-CN")}<span>点</span></> : <span className={styles.unavailable}>暂不可用</span>}</p><a href={MAP_WORKSPACE_URL} target="_blank" rel="noopener noreferrer" className={styles.smallLink}>前往地图创作<ArrowUpRight size={14} aria-hidden="true" /></a></section>}
                  <section className={styles.metric}><div className={styles.metricLabel}><MonitorCheck size={17} aria-hidden="true" /><span>有效登录会话</span></div><p className={styles.metricValue}>{loading ? <span className={styles.unavailable}>读取中</span> : sessions ? <>{sessions.length}<span>个</span></> : <span className={styles.unavailable}>暂不可用</span>}</p><a href="/dashboard#security" className={styles.smallLink}>查看登录安全<ArrowRight size={14} aria-hidden="true" /></a></section>
                  <section className={styles.metric}><div className={styles.metricLabel}><Mail size={17} aria-hidden="true" /><span>邮箱验证</span></div><p className={`${styles.metricValue} ${styles.statusValue} ${!user.emailVerifiedAt ? styles.pendingStatus : ""}`}>{user.emailVerifiedAt ? <><CheckCircle2 size={22} aria-hidden="true" />已验证</> : "未验证"}</p><span className={styles.metricHint}>加入于 {dateLabel(user.createdAt)}</span></section>
                </div>
                <section aria-labelledby="quick-products-heading"><div className={styles.sectionHeading}><div><h2 id="quick-products-heading">开始使用 GeoD</h2><p>从一个工具开始你的工作。</p></div><a className={styles.smallLink} href="/dashboard#products">全部产品<ArrowRight size={15} aria-hidden="true" /></a></div>
                  <div className={styles.quickProducts}>{products.slice(0, 3).map(product => <a key={product.id} className={styles.quickProduct} href={product.href} target={product.id === "geod" ? "_blank" : undefined} rel={product.id === "geod" ? "noopener noreferrer" : undefined}><span className={`${styles.productIcon} ${styles[product.color]}`}><product.icon size={23} strokeWidth={1.8} aria-hidden="true" /></span><h3>{product.name}</h3><p>{product.description}</p><span className={styles.productAction}>{product.action}<ArrowUpRight size={15} aria-hidden="true" /></span></a>)}</div>
                </section>
                {MAP_CREATION_VISIBLE && <div className={styles.infoStrip}><ShieldCheck size={19} aria-hidden="true" /><p>地图创作使用创作积分；CLI、MCP 和浏览器影像下载目前不消耗这些积分。</p></div>}
              </>}

              {section === "products" && <div className={styles.productGrid}>{products.map(product => <section className={styles.productCard} key={product.id}>
                <div className={styles.productCardHead}><span className={`${styles.productIcon} ${styles[product.color]}`}><product.icon size={24} strokeWidth={1.8} aria-hidden="true" /></span><span className={styles.productTag}>{product.tag}</span></div>
                <h2>{product.name}</h2><p>{product.description}</p><ButtonLink variant="secondary" href={product.href} target={product.id === "geod" ? "_blank" : undefined} rel={product.id === "geod" ? "noopener noreferrer" : undefined} className={styles.productButton}>{product.action}<ArrowUpRight size={15} aria-hidden="true" /></ButtonLink>
              </section>)}</div>}

              {section === "profile" && <div className={styles.profileContent}>
                <section className={styles.card} aria-labelledby="account-heading"><div className={styles.cardHeading}><h2 id="account-heading">账号信息</h2><span className={styles.badge}><Check size={14} aria-hidden="true" />已登录</span></div>
                  <dl className={styles.accountDetails}><div><dt>邮箱</dt><dd data-no-translate>{user.email}</dd></div><div><dt>验证状态</dt><dd>{user.emailVerifiedAt ? "邮箱已验证" : "邮箱未验证"}</dd></div><div><dt>加入时间</dt><dd>{dateLabel(user.createdAt)}</dd></div></dl>
                </section>
                <NicknameSettings key={user.id} user={user} onChange={updatedUser => setAccount(current => current?.user?.id === updatedUser.id ? { ...current, user: updatedUser } : current)} />
                <AvatarSettings key={user.id} user={user} onChange={updatedUser => setAccount(current => current?.user?.id === updatedUser.id ? { ...current, user: updatedUser } : current)} />
              </div>}

              {section === "security" && <div className={styles.securityGrid}>
                <section className={styles.card} aria-labelledby="password-heading"><div className={styles.cardHeading}><h2 id="password-heading">修改密码</h2><KeyRound size={19} aria-hidden="true" /></div><p className={styles.cardDescription}>更新后，其他设备的登录会话会退出，当前设备保持登录。</p>
                  <form className={styles.form} onSubmit={event => void updatePassword(event)}>
                    <div className={styles.field}><label htmlFor="current-password">当前密码</label><input id="current-password" type="password" autoComplete="current-password" required maxLength={128} disabled={busy} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></div>
                    <div className={styles.field}><label htmlFor="new-account-password">新密码</label><input id="new-account-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy} aria-describedby="password-help" value={newPassword} onChange={event => setNewPassword(event.target.value)} /><span id="password-help" className={styles.fieldHint}>12–128 个字符。</span></div>
                    <div className={styles.field}><label htmlFor="confirm-account-password">确认新密码</label><input id="confirm-account-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} /></div>
                    {securityError && <p className={styles.error} role="alert">{securityError}</p>}
                    {securityNotice && <p className={styles.notice} role="status">{securityNotice}</p>}
                    <Button className={styles.saveButton} type="submit" disabled={busy}>{busy ? "正在更新…" : "更新密码"}<ArrowRight size={16} aria-hidden="true" /></Button>
                  </form>
                </section>
                <section className={styles.card} aria-labelledby="sessions-heading"><div className={styles.cardHeading}><h2 id="sessions-heading">登录会话</h2><MonitorCheck size={19} aria-hidden="true" /></div><p className={styles.cardDescription}>这里只显示仍然有效的会话。</p>
                  {loading ? <p className={styles.sessionState} role="status">正在读取会话…</p> : sessionsError ? <div className={styles.sessionState}><p role="alert">会话读取失败。{sessionsError}</p><Button variant="secondary" size="sm" onClick={() => void load()}>重试</Button></div> : sessions?.length ? <ul className={styles.sessionList}>{sessions.map(session => <li key={session.id}><span className={styles.sessionIcon}><Monitor size={19} aria-hidden="true" /></span><div className={styles.sessionDetails}><div><strong>{session.current ? "当前登录" : "其他登录会话"}</strong>{session.current && <span className={styles.badge}>当前</span>}</div><p>登录于 {dateLabel(session.createdAt, true)}</p><p>有效期至 {dateLabel(session.expiresAt, true)}</p></div></li>)}</ul> : <p className={styles.sessionState}>暂未查到有效会话，可刷新重试。</p>}
                </section>
              </div>}
            </div>}
        </div>
      </main>
    </div>
  </div></LocalizedContent>;
}
