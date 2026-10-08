import type { Metadata } from "next";
import Header from "@/app/_components/Header";
import Footer from "@/app/_components/Footer";
import ApplicationForm from "@/app/apply/ApplicationForm";
export const metadata: Metadata = { title: "使用申请与接入帮助", description: "告诉我们你想使用的 GeoD 产品和场景，提交使用申请或接入问题。", robots: { index: false, follow: false } };
export default function ApplyPage() { return <><Header /><ApplicationForm /><Footer /></>; }
