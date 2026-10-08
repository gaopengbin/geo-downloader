import type { Metadata } from "next";
import dictionary from "./i18n/en.json";
import templates from "./i18n/templates.json";
import { DEFAULT_OG_IMAGE } from "./site";

export type Locale = "zh" | "en";
export const SITE_PATHS = ["/", "/agent", "/browser", "/cli", "/mcp", "/history", "/disclaimer", "/tools", "/login", "/dashboard"];
export const LANGUAGE_STORAGE_KEY = "geod.website.language";

export function localePath(href: string, locale: Locale): string {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  const [path] = href.split(/[?#]/);
  const bare = path === "/en" || path === "/en/" ? "/" : path.startsWith("/en/") ? path.slice(3) : path;
  const normalized = bare.length > 1 ? bare.replace(/\/$/, "") : bare;
  if (!SITE_PATHS.includes(normalized)) return href;
  return (locale === "en" ? normalized === "/" ? "/en" : `/en${normalized}` : normalized) + href.slice(path.length);
}

export function preferredLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved === "zh" || saved === "en") return saved;
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return "zh";
    if (/^en(?:-|$)/i.test(language)) return "en";
  }
  return "zh";
}

const entries: Record<string, string> = { ...dictionary, ...templates };
const parts = Object.keys(entries).sort((a, b) => b.length - a.length);
const pattern = new RegExp(parts.map(text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");

export function translate(text: string, locale: Locale): string {
  if (locale !== "en") return text;
  const normalized = text.replace(/\s+/g, " ").trim();
  const exact = entries[normalized];
  const translated = exact ? text.replace(text.trim(), exact) : text.replace(pattern, match => entries[match]);
  const punctuation: Record<string, string> = { "，": ", ", "。": ".", "：": ": ", "；": "; ", "（": "(", "）": ")", "、": ", ", "｜": " | " };
  return translated.replace(/[，。：；（）、｜]/g, mark => punctuation[mark]);
}

// Only the prose within published code examples changes. Command names,
// arguments, URLs, paths, JSON keys and formatting remain identical.
const exampleLabels: Record<string, string> = {
  "下载 6 级及以上时，在浏览器完成授权": "Authorize in your browser for downloads at level 6 and above",
  "我的图源": "MySource", "数据提供方": "DataProvider",
  "Blue Marble 多级影像示例": "Blue Marble multi-level imagery example",
  "请求校验失败": "Request validation failed", "下载失败": "Download failed", "成果校验失败": "Output validation failed",
};
export function localizedExample(text: string, locale: Locale): string {
  if (locale !== "en") return text;
  for (const [source, target] of Object.entries(exampleLabels)) text = text.split(source).join(target);
  return text;
}

export function pageMetadata(source: Metadata, locale: Locale, path: string): Metadata {
  const title = typeof source.title === "string" ? translate(source.title, locale) : source.title && "default" in source.title
    ? { ...source.title, default: translate(source.title.default, locale) } : source.title;
  const description = source.description ? translate(source.description, locale) : source.description;
  return { ...source, title, description, keywords: typeof source.keywords === "string" ? translate(source.keywords, locale) : source.keywords,
    alternates: { canonical: localePath(path, locale), languages: { "zh-CN": path, en: localePath(path, "en"), "x-default": path } },
    openGraph: { type: "website", siteName: "GeoD", images: [DEFAULT_OG_IMAGE], ...source.openGraph, title: typeof title === "string" ? title : undefined, description: description ?? undefined, url: localePath(path, locale), locale: locale === "en" ? "en_US" : "zh_CN", alternateLocale: locale === "en" ? "zh_CN" : "en_US" },
    twitter: { card: "summary_large_image", images: source.openGraph?.images ?? [DEFAULT_OG_IMAGE], ...source.twitter, title: typeof title === "string" ? title : undefined, description: description ?? undefined },
  };
}
