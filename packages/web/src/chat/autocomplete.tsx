import { useEffect, useRef } from "react";
import type { SlashCommand } from "./slashCommands.js";
import { cx } from "../util/classnames.js";

interface Props {
  commands: SlashCommand[];
  activeIndex: number;
  onSelect: (cmd: SlashCommand) => void;
  onClose: () => void;
}

export function AutocompletePopover({ commands, activeIndex, onSelect, onClose }: Props) {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (commands.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 mb-1 w-full max-w-sm bg-bg-elev border border-border rounded-xl shadow-xl z-50 overflow-hidden">
      <ul ref={listRef} className="max-h-64 overflow-y-auto py-1">
        {commands.map((cmd, i) => (
          <li key={cmd.name}>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(cmd);
              }}
              className={cx(
                "w-full text-left px-3 py-2 flex items-baseline gap-3 transition-colors",
                i === activeIndex ? "bg-accent/20 text-fg" : "hover:bg-bg-soft text-fg-muted",
              )}
            >
              <span className="font-mono text-sm text-accent-soft">/{cmd.name}</span>
              {cmd.args.length > 0 && (
                <span className="text-xs text-fg-subtle">
                  {cmd.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ")}
                </span>
              )}
              <span className="text-xs text-fg-subtle ml-auto truncate">{cmd.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
