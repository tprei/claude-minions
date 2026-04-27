import type { ReactElement } from "react";
import { cx } from "../util/classnames.js";

interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeClass = {
  sm: "w-4 h-4 border-2",
  md: "w-6 h-6 border-2",
  lg: "w-8 h-8 border-[3px]",
};

export function Spinner({ size = "md", className }: SpinnerProps): ReactElement {
  return (
    <span
      role="status"
      aria-label="loading"
      className={cx(
        "inline-block rounded-full border-zinc-600 border-t-accent animate-spin",
        sizeClass[size],
        className,
      )}
    />
  );
}
