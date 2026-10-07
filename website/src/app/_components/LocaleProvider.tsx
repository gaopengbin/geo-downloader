"use client";

import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { LANGUAGE_STORAGE_KEY, localePath, preferredLocale, translate, type Locale } from "@/lib/i18n";
import styles from "./Header/styles.module.css";

const LocaleContext = createContext<Locale>("zh");
export const useLocale = () => useContext(LocaleContext);

// Translate at render time, including server-rendered page content. Code, input
// values and user content are deliberately excluded; URLs only use known routes.
function localize(node: ReactNode, locale: Locale): ReactNode {
  if (typeof node === "string") return translate(node, locale);
  if (Array.isArray(node)) return Children.map(node, child => localize(child, locale));
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  const props = node.props;
  if (props["data-no-translate"] || node.type === "code" || node.type === "pre" || node.type === "script" || node.type === "style") return node;
  const localized: Record<string, unknown> = {};
  if ("children" in props) localized.children = localize(props.children as ReactNode, locale);
  for (const name of ["title", "alt", "aria-label", "placeholder", "label", "caption"]) {
    const value = props[name];
    if (typeof value === "string") localized[name] = translate(value, locale);
  }
  if (typeof props.href === "string") localized.href = localePath(props.href, locale);
  return cloneElement(node, localized);
}

export function LocalizedContent({ children }: { children: ReactNode }) {
  const locale = useLocale();
  return <>{localize(children, locale)}</>;
}

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  useEffect(() => {
    // An explicit English URL always stays English. Chinese is the default URL;
    // an explicit manual choice is remembered and takes precedence next time.
    if (locale === "en") return;
    let saved: string | null = null;
    try { saved = localStorage.getItem(LANGUAGE_STORAGE_KEY); } catch { /* Private browsing may disable storage. */ }
    const preferred = preferredLocale(saved, navigator.languages ?? [navigator.language]);
    if (preferred === "en") {
      const current = location.pathname + location.search + location.hash;
      const target = localePath(current, preferred);
      if (target !== current) location.replace(target);
    }
  }, [locale]);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function LanguageSwitch() {
  const locale = useLocale();
  const pathname = usePathname() || "/";
  const target: Locale = locale === "en" ? "zh" : "en";
  const [suffix, setSuffix] = useState("");
  useEffect(() => {
    const update = () => setSuffix(location.search + location.hash);
    update();
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => { window.removeEventListener("hashchange", update); window.removeEventListener("popstate", update); };
  }, [pathname]);
  return <a className={styles.languageSwitch} href={localePath(pathname, target) + suffix} lang={target === "en" ? "en" : "zh-CN"}
    hrefLang={target === "en" ? "en" : "zh-CN"} aria-label={locale === "en" ? "Switch to Chinese" : "切换为英文"}
    onClick={event => {
      try { localStorage.setItem(LANGUAGE_STORAGE_KEY, target); } catch { /* Switching still works without storage. */ }
      event.currentTarget.href = localePath(location.pathname + location.search + location.hash, target);
    }}>{locale === "en" ? "中文" : "EN"}</a>;
}
