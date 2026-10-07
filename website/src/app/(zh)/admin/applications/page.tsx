import type { Metadata } from "next";
import Header from "@/app/_components/Header";
import Footer from "@/app/_components/Footer";
import ApplicationAdmin from "@/app/admin/applications/ApplicationAdmin";
export const metadata: Metadata = { title: "申请管理", robots: { index:false,follow:false } };
export default function ApplicationsPage(){return <><Header /><ApplicationAdmin /><Footer /></>;}
