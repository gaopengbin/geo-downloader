import { LocalizedContent } from "@/app/_components/LocaleProvider";
import type { Metadata } from "next";
import Background from "../_components/Background";
import Footer from "../_components/Footer";
import Header from "../_components/Header";
import AccountLogin from "./AccountLogin";

export const metadata: Metadata = {
  title: "登录 GeoD",
  description: "登录或注册 GeoD 账号，进入个人控制台并授权 GeoD 工具。",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return <LocalizedContent><><Background sticky /><Header /><AccountLogin /><Footer /></></LocalizedContent>;
}
