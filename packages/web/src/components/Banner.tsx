import type { ReactElement, ReactNode } from "react";
import { cx } from "../util/classnames.js";

export type BannerTone = "error" | "warning" | "info" | "success";

export interface BannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  message: ReactNode;
  detail?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}

const toneClass: Record<BannerTone, string> = {
  error: "border-tone-err-border bg-tone-err-bg text-tone-err-fg",
  warning: "border-tone-warn-border bg-tone-warn-bg text-tone-warn-fg",
  info: "border-accent/40 bg-accent/10 text-fg-muted",
  success: "border-tone-ok-border bg-tone-ok-bg text-tone-ok-fg",
};

const dismissTone: Record<BannerTone, string> = {
  error: "text-tone-err-fg/70 hover:text-tone-err-fg",
  warning: "text-tone-warn-fg/70 hover:text-tone-warn-fg",
  info: "text-fg-subtle hover:text-fg-muted",
  success: "text-tone-ok-fg/70 hover:text-tone-ok-fg",
};

export function Banner({
  tone = "error",
  title,
  message,
  detail,
  onDismiss,
  className,
}: BannerProps): ReactElement {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx(
        "rounded border px-3 py-2 text-xs flex items-start gap-2",
        toneClass[tone],
        className,
      )}
    >
      <div className="flex-1 min-w-0">
        {title && <div className="font-semibold text-sm leading-tight">{title}</div>}
        <div className={cx("leading-snug", title ? "mt-0.5" : null)}>{message}</div>
        {detail && <div className="mt-1 font-mono text-[11px] opacity-80 break-all">{detail}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          className={cx("shrink-0 leading-none", dismissTone[tone])}
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          ✕
        </button>
      )}
    </div>
  );
}
