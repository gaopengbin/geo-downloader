import type { Metadata } from "next";
import Header from "../_components/Header";
import Footer from "../_components/Footer";
import ApplicationForm from "./ApplicationForm";
export const metadata: Metadata = { title: "使用申请与接入帮助", description: "告诉我们你想使用的 GeoD 产品和场景，提交使用申请或接入问题。" };
export default function ApplyPage() { return <><Header /><ApplicationForm /><Footer /></>; }
