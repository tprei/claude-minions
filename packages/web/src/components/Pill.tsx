import type { ReactElement, ReactNode } from "react";
import { cx } from "../util/classnames.js";

interface PillProps {
  children: ReactNode;
  color?: string;
  className?: string;
}

export function Pill({ children, color, className }: PillProps): ReactElement {
  return (
    <span
      className={cx("pill bg-bg-elev text-fg-muted border border-border", className)}
      style={color ? { borderColor: color, color } : undefined}
    >
      {children}
    </span>
  );
}
