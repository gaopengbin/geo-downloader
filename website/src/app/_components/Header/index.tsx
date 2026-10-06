"use client";

import cn from "classnames";
import Link from "next/link";
import { useEffect, useState } from "react";

import Logo from "../Logo";
import AccountMenu from "./AccountMenu";
import MobileMenu, { type HeaderNavLink } from "./MobileMenu";
import { accountRequest, type GeoDAccount } from "@/lib/account";
import { subscribeAccountChanges } from "@/lib/account-events";
import { MAP_CREATION_VISIBLE, MAP_WORKSPACE_URL } from "@/lib/site";
import urls from "@/lib/urls";
import styles from "./styles.module.css";

interface HeaderProps extends React.HTMLProps<HTMLElement> {
  isHome?: boolean;
}

const productLinks: HeaderNavLink[] = [
  { content: "桌面端", href: "/#download" },
  { content: "浏览器版", href: "/browser" },
  { content: "CLI", href: "/cli" },
  { content: "MCP", href: "/mcp" },
  { content: "地图创作", href: MAP_WORKSPACE_URL, target: "_blank" },
].filter(link => MAP_CREATION_VISIBLE || link.href !== MAP_WORKSPACE_URL);

const Header: React.FC<HeaderProps> = ({ isHome, className, ...rest }) => {
  const [user, setUser] = useState<GeoDAccount["user"] | undefined>(undefined);

  useEffect(() => {
    let active = true;
    let requestVersion = 0;
    const refresh = async () => {
      const version = ++requestVersion;
      try {
        const account = await accountRequest<GeoDAccount>("/api/account");
        if (active && version === requestVersion) setUser(account.user);
      } catch {
        if (active && version === requestVersion) setUser(current => current === undefined ? null : current);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    window.addEventListener("focus", refresh);
    const unsubscribe = subscribeAccountChanges(() => void refresh());
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const guestLink: HeaderNavLink = { content: "登录 / 注册", href: "/login", isCta: true };
  const desktopLinks = user === null ? [...productLinks, guestLink] : productLinks;
  const mobileLinks = user === undefined ? productLinks : [...productLinks, user ? { content: "个人控制台", href: "/dashboard" } : guestLink];

  return (
    <header className={cn(styles.container, className)} {...rest}>
      <div className={styles.navbar}>
        <div className={styles.content}>
          <div className={cn(styles.logo, "z-10")}>
            <Link href={urls.getHomeUrl()}>
              <Logo />
            </Link>
          </div>
          <div className={styles.desktopNav}>
            <nav
              aria-label="Main"
              className={cn(styles.desktopLinks, "pointer-events-auto")}
            >
              {desktopLinks.map(
                ({
                  href,
                  target,
                  content,
                  className: linkClass,
                  leadingIcon,
                  isCta,
                }) => (
                  <a
                    key={content}
                    href={href}
                    target={target}
                    rel={target === "_blank" ? "noopener noreferrer" : undefined}
                    className={cn(
                      styles.link,
                      isCta && styles.ctaLinkOverride,
                      linkClass,
                    )}
                  >
                    {leadingIcon ? (
                      <span className="inline-flex items-center gap-2">
                        {leadingIcon}
                        <span>{content}</span>
                      </span>
                    ) : (
                      content
                    )}
                  </a>
                ),
              )}
              {user === undefined && <span className={styles.authPlaceholder} aria-hidden="true" />}
            </nav>
          </div>
          {user && <AccountMenu user={user} onLoggedOut={() => setUser(null)} />}
          <MobileMenu isHome={isHome} links={mobileLinks} />
        </div>
      </div>
    </header>
  );
};

export default Header;
