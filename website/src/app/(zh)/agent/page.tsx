import Page, { metadata as source } from "@/app/agent/PageContent";
import { pageMetadata } from "@/lib/i18n";
export const metadata = pageMetadata(source, "zh", "/agent");
export default function AgentPage() { return <Page locale="zh" />; }
