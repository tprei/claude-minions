import type { ReactElement, ReactNode } from "react";
import { cx } from "../util/classnames.js";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps): ReactElement {
  return (
    <div className={cx("flex flex-col items-center justify-center text-center gap-3 py-16 px-4", className)}>
      {icon && (
        <div className="text-fg-subtle text-4xl">{icon}</div>
      )}
      <p className="text-sm font-medium text-fg-muted">{title}</p>
      {description && (
        <p className="text-xs text-fg-subtle max-w-xs">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
