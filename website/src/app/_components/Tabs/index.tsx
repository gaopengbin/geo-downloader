"use client";
import cn from "classnames";
import { ReactNode, useEffect, useId, useState } from "react";
import TabSelect from "../TabSelect";
import styles from "./styles.module.css";

export type Tab = {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  content: ReactNode;
};

export type Props = {
  tabs: Tab[];
};
export const Tabs = (props: Props) => {
  const { tabs } = props;
  const instanceId = useId();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [prevIndex, setPrevIndex] = useState(selectedIndex);
  const inTransition = prevIndex !== selectedIndex;
  const visibleIndices = inTransition
    ? Array.from(new Set([prevIndex, selectedIndex]))
    : [selectedIndex];

  useEffect(() => {
    if (!inTransition) {
      return;
    }
    const fun = () => {
      setPrevIndex(selectedIndex);
    };
    const timeout = setTimeout(
      fun,
      250 // animation duration
    );
    return () => {
      clearTimeout(timeout);
    };
  }, [inTransition, selectedIndex]);
  return (
    <div className={styles.container}>
      <TabSelect
        variant="underline"
        instanceId={instanceId}
        selectedIndex={selectedIndex}
        tabs={tabs.map((t, i) => ({
          ...t,
          onClick: () => setSelectedIndex(i),
        }))}
      />
      <div className={styles.panels}>
        {visibleIndices.map((i) => {
          const t = tabs[i];
          return (
            <div
              key={t.id}
              id={`${instanceId}-panel-${t.id}`}
              role="tabpanel"
              aria-labelledby={`${instanceId}-tab-${t.id}`}
              aria-hidden={i !== selectedIndex}
              tabIndex={0}
              className={cn(styles.panel, i === selectedIndex && styles.selected)}
            >
              {t.content}
            </div>
          );
        })}
      </div>
    </div>
  );
};
