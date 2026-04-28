import { cx } from "../util/classnames.js";

export interface Tab {
  id: string;
  label: string;
}

interface Props {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

export function Tabs({ tabs, active, onChange, className }: Props) {
  return (
    <div className={cx("flex border-b border-border overflow-x-auto", className)}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={cx(
            "px-4 py-2 text-xs transition-colors whitespace-nowrap",
            active === tab.id
              ? "text-fg border-b-2 border-accent -mb-px"
              : "text-fg-subtle hover:text-fg-muted",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
