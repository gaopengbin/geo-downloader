import SiteDocument, { metadata as source } from "@/app/SiteDocument";
import { pageMetadata } from "@/lib/i18n";
export const metadata = pageMetadata(source, "en", "/");
export default function Layout({children}: {children: React.ReactNode}) { return <SiteDocument locale="en">{children}</SiteDocument>; }
