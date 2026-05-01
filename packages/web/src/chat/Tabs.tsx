import { useEffect, useRef } from "react";
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
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  useEffect(() => {
    const node = buttonRefs.current.get(active);
    if (node) {
      node.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    }
  }, [active]);

  return (
    <div
      className={cx(
        "flex overflow-x-auto snap-x border-b border-border scrollbar-none",
        className,
      )}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          ref={(el) => {
            if (el) buttonRefs.current.set(tab.id, el);
            else buttonRefs.current.delete(tab.id);
          }}
          onClick={() => onChange(tab.id)}
          className={cx(
            "px-3 py-2 md:py-2 text-xs min-h-11 md:min-h-0 snap-start shrink-0 transition-colors whitespace-nowrap",
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
