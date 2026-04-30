import { useState } from "react";
import type { ToolCallEvent, ToolResultEvent } from "@minions/shared";
import { cx } from "../../util/classnames.js";
import {
  KIND_COLOR,
  KIND_ICONS,
  KIND_VERBS,
  ToolCallRow,
} from "./ToolCallRow.js";

export interface ToolCallGroupItem {
  call: ToolCallEvent;
  result?: ToolResultEvent;
}

interface Props {
  items: ToolCallGroupItem[];
}

function pluralize(toolName: string, count: number): string {
  return count === 1 ? toolName : `${toolName}s`;
}

function clusterLabel(items: ToolCallGroupItem[]): string {
  const count = items.length;
  const first = items[0]?.call.toolName;
  if (first && items.every((it) => it.call.toolName === first)) {
    return `${count} ${pluralize(first, count)}`;
  }
  return `${count} tool ${count === 1 ? "call" : "calls"}`;
}

export function ToolCallGroup({ items }: Props) {
  const hasError = items.some((it) => it.result?.status === "error");
  const [open, setOpen] = useState(items.length < 3 || hasError);

  if (items.length === 0) return null;

  return (
    <div className="rounded-md border border-border-soft bg-bg-soft/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-2 py-1 text-left text-[12px]"
      >
        <span
          className={cx(
            "shrink-0 text-fg-subtle text-xs transition-transform",
            open ? "rotate-90" : "",
          )}
        >
          ›
        </span>
        <span className="text-fg-muted font-medium shrink-0">{clusterLabel(items)}</span>
        <span className="flex items-center gap-0.5 text-[11px] truncate">
          {items.map((it, i) => (
            <span
              key={i}
              className={cx("shrink-0", KIND_COLOR[it.call.toolKind] ?? "text-fg-muted")}
              title={KIND_VERBS[it.call.toolKind]}
            >
              {KIND_ICONS[it.call.toolKind]}
            </span>
          ))}
        </span>
        {hasError && (
          <span className="pill border text-[10px] bg-red-900/40 text-red-400 border-red-800/60 ml-auto shrink-0">
            FAIL
          </span>
        )}
      </button>
      {open && (
        <div className="px-1 pb-1 space-y-0.5">
          {items.map((it) => (
            <ToolCallRow key={it.call.id} call={it.call} result={it.result} />
          ))}
        </div>
      )}
    </div>
  );
}
