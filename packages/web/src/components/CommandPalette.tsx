import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { cx } from "../util/classnames.js";
import type { PaletteAction } from "./CommandPalette.actions.js";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
}

interface RenderRow {
  kind: "header" | "action";
  group?: string;
  action?: PaletteAction;
  index?: number;
}

function filterActions(actions: PaletteAction[], query: string): PaletteAction[] {
  const q = query.trim().toLowerCase();
  if (!q) return actions;
  return actions.filter(a => {
    const label = a.label.toLowerCase();
    const group = (a.group ?? "").toLowerCase();
    return label.includes(q) || group.includes(q);
  });
}

function groupRows(actions: PaletteAction[]): RenderRow[] {
  const order: string[] = [];
  const buckets = new Map<string, PaletteAction[]>();
  for (const a of actions) {
    const g = a.group ?? "Other";
    if (!buckets.has(g)) {
      buckets.set(g, []);
      order.push(g);
    }
    buckets.get(g)!.push(a);
  }
  const rows: RenderRow[] = [];
  let actionIndex = 0;
  for (const g of order) {
    rows.push({ kind: "header", group: g });
    for (const a of buckets.get(g)!) {
      rows.push({ kind: "action", action: a, index: actionIndex++ });
    }
  }
  return rows;
}

export function CommandPalette({ open, onClose, actions }: CommandPaletteProps): ReactElement | null {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => filterActions(actions, query), [actions, query]);
  const rows = useMemo(() => groupRows(filtered), [filtered]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    if (filtered.length === 0) return;
    const clamped = Math.min(selected, filtered.length - 1);
    if (clamped !== selected) {
      setSelected(clamped);
      return;
    }
    const el = listRef.current?.querySelector<HTMLElement>(`[data-action-index="${clamped}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, selected, filtered.length]);

  if (!open) return null;

  function runSelected(): void {
    const action = filtered[selected];
    if (!action) return;
    onClose();
    queueMicrotask(() => action.run());
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setSelected(s => (s + 1) % filtered.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setSelected(s => (s - 1 + filtered.length) % filtered.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      runSelected();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4" onKeyDown={onKeyDown}>
      <div
        className="absolute inset-0 bg-bg/80 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative card w-full max-w-xl shadow-2xl overflow-hidden">
        <div className="px-3 py-2 border-b border-border">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Type a command, view, or session…"
            className="w-full bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {rows.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-fg-subtle">No matches</div>
          )}
          {rows.map((row, i) => {
            if (row.kind === "header") {
              return (
                <div
                  key={`h:${row.group}:${i}`}
                  className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-fg-subtle"
                >
                  {row.group}
                </div>
              );
            }
            const action = row.action!;
            const idx = row.index!;
            const isSelected = idx === selected;
            return (
              <button
                key={action.id}
                data-action-index={idx}
                type="button"
                onMouseEnter={() => setSelected(idx)}
                onClick={() => {
                  setSelected(idx);
                  onClose();
                  queueMicrotask(() => action.run());
                }}
                className={cx(
                  "w-full flex items-center justify-between gap-3 px-3 py-1.5 text-left text-sm transition-colors",
                  isSelected ? "bg-accent/20 text-fg" : "text-fg-muted hover:bg-bg-soft",
                )}
              >
                <span className="truncate">{action.label}</span>
                {action.hint && (
                  <span className="text-xs text-fg-subtle truncate max-w-[40%]">{action.hint}</span>
                )}
              </button>
            );
          })}
        </div>
        <div className="px-3 py-2 border-t border-border flex items-center justify-between text-[10px] text-fg-subtle">
          <span className="flex items-center gap-2">
            <span className="kbd">↑↓</span> navigate
            <span className="kbd">↵</span> run
            <span className="kbd">esc</span> close
          </span>
          <span>{filtered.length} {filtered.length === 1 ? "result" : "results"}</span>
        </div>
      </div>
    </div>
  );
}
