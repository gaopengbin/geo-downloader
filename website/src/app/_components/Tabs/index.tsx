"use client";
import { LocalizedContent } from "@/app/_components/LocaleProvider";

import type { ReactNode } from "react";
import { Tabs as MotionTabs, TabsContent, TabsList, TabsTrigger } from "@/components/motion/tabs";
import styles from "./styles.module.css";

export type Tab = { id: string; label: ReactNode; icon?: ReactNode; content: ReactNode };

export function Tabs({ tabs }: { tabs: Tab[] }) {
  if (!tabs.length) return null;
  return (
    <LocalizedContent><MotionTabs defaultValue={tabs[0].id} variant="underline" className={styles.container}>
      <TabsList className={styles.list} wrapperClassName={styles.listWrap}>
        {tabs.map(tab => <TabsTrigger key={tab.id} value={tab.id} className={styles.trigger} indicatorClassName={styles.indicator}>
          {tab.icon}{tab.label}
        </TabsTrigger>)}
      </TabsList>
      {tabs.map(tab => <TabsContent key={tab.id} value={tab.id} className={styles.panel}>{tab.content}</TabsContent>)}
    </MotionTabs></LocalizedContent>
  );
}
