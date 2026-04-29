import type { ReactNode } from "react";
import { cx } from "../util/classnames.js";

interface Props {
  children: ReactNode;
  className?: string;
}

export function InlineCode({ children, className }: Props) {
  return (
    <code
      className={cx(
        "font-mono bg-bg-soft text-fg px-1 py-0.5 rounded text-[12px]",
        className,
      )}
    >
      {children}
    </code>
  );
}
