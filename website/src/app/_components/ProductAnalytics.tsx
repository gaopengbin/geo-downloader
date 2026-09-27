"use client";

import { useEffect, type AnchorHTMLAttributes, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { trackProductEvent } from "@/lib/product-analytics";

export function ProductPageView() {
  const pathname = usePathname();

  useEffect(() => {
    void trackProductEvent("page_view");
  }, [pathname]);

  return null;
}

type TrackedDownloadLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  children: ReactNode;
  platform: string;
  version: string;
};

export function TrackedDownloadLink({
  children,
  platform,
  version,
  href,
  onClick,
  ...props
}: TrackedDownloadLinkProps) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        const target = typeof href === "string" ? href : "";
        void trackProductEvent("download_clicked", {
          platform,
          version,
          channel: target.includes("laogao.xyz") ? "mirror" : "github",
        });
      }}
    >
      {children}
    </a>
  );
}

type TrackedInstallLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  children: ReactNode;
  artifact: "cli" | "mcp" | "skill";
  channel: "npm" | "github" | "mirror" | "site";
};

export function TrackedInstallLink({ children, artifact, channel, onClick, ...props }: TrackedInstallLinkProps) {
  return <a {...props} onClick={(event) => {
    onClick?.(event);
    if (!event.defaultPrevented) void trackProductEvent("install_link_clicked", { artifact, channel });
  }}>{children}</a>;
}
