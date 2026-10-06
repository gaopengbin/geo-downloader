import type { Metadata } from "next";
import Header from "../../_components/Header";
import Footer from "../../_components/Footer";
import ApplicationAdmin from "./ApplicationAdmin";
export const metadata: Metadata = { title: "申请管理", robots: { index:false,follow:false } };
export default function ApplicationsPage(){return <><Header /><ApplicationAdmin /><Footer /></>;}
