"use client";
import { useLocale } from "./LocaleProvider";

export default function LocalizedDate({ value }: { value: string }) {
  const locale = useLocale();
  return <time dateTime={value}>{new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC",
  }).format(new Date(value))}</time>;
}
