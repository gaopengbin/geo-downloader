import type { Metadata } from "next";
import AccountDashboard from "./AccountDashboard";

export const metadata: Metadata = {
  title: "我的 GeoD｜个人控制台",
  description: "查看 GeoD 账号和可用产品入口。",
  robots: { index: false, follow: false },
};

export default function DashboardPage() {
  return <AccountDashboard />;
}
