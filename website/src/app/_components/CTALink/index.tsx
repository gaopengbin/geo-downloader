import { AnchorHTMLAttributes } from "react";

import cn from "classnames";
import styles from "./styles.module.css";

interface CTALinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: "primary" | "secondary" | "tertiary";
  full?: boolean;
}

export const getCtaClassName = ({ className, variant, full }: CTALinkProps) => {
  let variantClass;
  if (variant === "secondary") {
    variantClass = styles.secondary;
  } else if (variant === "tertiary") {
    variantClass = styles.tertiary;
  } else {
    variantClass = styles.primary;
  }

  return cn(styles.ctaLink, variantClass, full && styles.full, className);
};

/**
 * Call To Action Link
 */
const CTALink = (props: CTALinkProps) => {
  const { children, variant, full, ...rest } = props;
  return (
    <a {...rest} className={getCtaClassName(props)}>
      {children}
    </a>
  );
};

export default CTALink;
