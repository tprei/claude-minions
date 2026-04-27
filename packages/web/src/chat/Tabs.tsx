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
    <div className={cx("flex border-b border-border", className)}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={cx(
            "px-4 py-2 text-xs transition-colors whitespace-nowrap",
            active === tab.id
              ? "text-zinc-100 border-b-2 border-accent -mb-px"
              : "text-zinc-500 hover:text-zinc-300",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
