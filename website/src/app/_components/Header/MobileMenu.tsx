"use client";

import cn from "classnames";
import type { ReactNode } from "react";
import { useState } from "react";
import styles from "./styles.module.css";

export interface HeaderNavLink {
  content: string;
  href: string;
  className?: string;
  isCta?: boolean;
  leadingIcon?: ReactNode;
  target?: string;
}

interface MobileMenuProps {
  isHome?: boolean;
  links: HeaderNavLink[];
}

export default function MobileMenu({ isHome, links }: MobileMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className={cn(styles.drawerButton, "z-10")}
        aria-expanded={open}
        aria-label={open ? "关闭导航" : "打开导航"}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="sr-only">{open ? "关闭导航" : "打开导航"}</span>
        <svg
          aria-hidden="true"
          className="h-6 w-6"
          fill="none"
          viewBox="0 0 24 24"
        >
          {open ? (
            <path
              d="M6 6l12 12M18 6 6 18"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
          ) : (
            <path
              d="M4 7h16M4 12h16M4 17h16"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
          )}
        </svg>
      </button>

      <div
        className={cn(
          styles.drawer,
          open && styles.open,
          isHome && styles.homeDrawer,
        )}
      >
        <nav className={cn(styles.mobileLinks, "!gap-4")} aria-label="Mobile">
          {links.map(
            ({ href, target, content, className, leadingIcon, isCta }) => (
              <a
                key={content}
                href={href}
                target={target}
                rel={target === "_blank" ? "noopener noreferrer" : undefined}
                onClick={() => setOpen(false)}
                className={cn(
                  styles.link,
                  isCta && styles.ctaLinkOverride,
                  className,
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
    </>
  );
}
