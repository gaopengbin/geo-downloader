import cn from "classnames";
import Link from "next/link";

import { getCtaClassName } from "../CTALink";
import Logo from "../Logo";
import MobileMenu, { type HeaderNavLink } from "./MobileMenu";
import urls from "@/lib/urls";
import styles from "./styles.module.css";

interface HeaderProps extends React.HTMLProps<HTMLElement> {
  isHome?: boolean;
}

const navLinks: HeaderNavLink[] = [
  { content: "能力", href: "/#features" },
  { content: "界面", href: "/#screenshots" },
  { content: "下载", href: "/#download" },
  { content: "历史版本", href: "/history" },
  { content: "免责声明", href: "/disclaimer" },
  {
    content: "GitHub",
    href: urls.getGithubUrl(),
    target: "_blank",
  },
  {
    content: "下载 GeoD",
    className: getCtaClassName({ variant: "primary" }),
    href: "/#download",
    isCta: true,
  },
];

const Header: React.FC<HeaderProps> = ({ isHome, className, ...rest }) => {
  return (
    <header className={cn(styles.container)} {...rest}>
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
              {navLinks.map(
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
            </nav>
          </div>
          <MobileMenu isHome={isHome} links={navLinks} />
        </div>
      </div>
    </header>
  );
};

export default Header;
