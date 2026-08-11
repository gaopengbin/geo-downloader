"use client";
import {
  HTMLAttributes,
  KeyboardEvent,
  ReactNode,
  useRef,
} from "react";

import cn from "classnames";
import styles from "./styles.module.css";

export interface Tab {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  onClick: (tab: Tab, index: number) => void;
}

interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  variant?: "underline" | "pill";
  selectedIndex: number;
  tabs: Tab[];
  instanceId: string;
}

const TabSelect = ({ variant, tabs, selectedIndex, instanceId, ...rest }: Props) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }

    event.preventDefault();
    let nextIndex = selectedIndex;

    if (event.key === "ArrowLeft") nextIndex = (selectedIndex - 1 + tabs.length) % tabs.length;
    if (event.key === "ArrowRight") nextIndex = (selectedIndex + 1) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;

    tabs[nextIndex]?.onClick(tabs[nextIndex], nextIndex);
    containerRef.current
      ?.querySelectorAll<HTMLButtonElement>("[role='tab']")
      [nextIndex]?.focus();
  };

  return (
    <div
      {...rest}
      ref={containerRef}
      role="tablist"
      aria-label="产品模块"
      onKeyDown={handleKeyDown}
      className={cn(
        styles.container,
        variant === "underline" ? styles.underline : styles.pill
      )}
    >
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          id={`${instanceId}-tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={selectedIndex === i}
          aria-controls={`${instanceId}-panel-${tab.id}`}
          tabIndex={selectedIndex === i ? 0 : -1}
          className={cn(styles.tab, selectedIndex === i && styles.selected)}
          onClick={() => tab.onClick(tab, i)}
        >
          <div className={styles.label}>
            {tab.icon && <div className={styles.icon}>{tab.icon}</div>}
            {tab.label}
          </div>
        </button>
      ))}
    </div>
  );
};

export default TabSelect;
