import { useEffect, useRef } from "react";
import { cx } from "../util/classnames.js";

interface Props {
  paths: string[];
  activeIndex: number;
  onSelect: (path: string) => void;
  onClose: () => void;
}

function splitPath(path: string): { dir: string; base: string } {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return { dir: "", base: path };
  return { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) };
}

export function FileMentionPopover({ paths, activeIndex, onSelect, onClose }: Props) {
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

  if (paths.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 mb-1 w-full max-w-sm bg-bg-elev border border-border rounded-xl shadow-xl z-50 overflow-hidden">
      <ul ref={listRef} className="max-h-64 overflow-y-auto py-1">
        {paths.map((path, i) => {
          const { dir, base } = splitPath(path);
          return (
            <li key={path}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(path);
                }}
                className={cx(
                  "w-full text-left px-3 py-2 flex items-baseline gap-1 transition-colors font-mono text-sm",
                  i === activeIndex ? "bg-accent/20 text-fg" : "hover:bg-bg-soft text-fg-muted",
                )}
              >
                {dir && <span className="text-fg-subtle">{dir}</span>}
                <span className="text-fg">{base}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
