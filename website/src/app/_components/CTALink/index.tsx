"use client";

import cn from "classnames";
import { ButtonLink, type ButtonLinkProps } from "@/components/motion/button/base";
import styles from "./styles.module.css";

type CTALinkProps = Omit<ButtonLinkProps, "variant" | "size"> & {
  variant?: "primary" | "secondary" | "tertiary";
  full?: boolean;
};

export default function CTALink({ variant = "primary", full, className, children, ...rest }: CTALinkProps) {
  return <ButtonLink
    {...rest}
    variant={variant === "tertiary" ? "ghost" : variant}
    size="lg"
    className={cn(styles.ctaLink, styles[variant], full && styles.full, className)}
  >{children}</ButtonLink>;
}
