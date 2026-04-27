import type { ReactElement } from "react";
import type { SessionStatus } from "../types.js";
import { cx } from "../util/classnames.js";

interface StatusDotProps {
  status: SessionStatus;
  size?: "sm" | "md";
  className?: string;
}

const statusColor: Record<SessionStatus, string> = {
  pending: "bg-zinc-500",
  running: "bg-ok animate-pulse",
  waiting_input: "bg-warn animate-pulse",
  completed: "bg-ok",
  failed: "bg-err",
  cancelled: "bg-zinc-600",
};

const sizeClass = {
  sm: "w-1.5 h-1.5",
  md: "w-2 h-2",
};

export function StatusDot({ status, size = "md", className }: StatusDotProps): ReactElement {
  return (
    <span
      aria-label={status}
      className={cx(
        "inline-block rounded-full flex-shrink-0",
        statusColor[status],
        sizeClass[size],
        className,
      )}
    />
  );
}
