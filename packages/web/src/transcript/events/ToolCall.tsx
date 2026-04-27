import { useState } from "react";
import type { ToolCallEvent, ToolKind } from "@minions/shared";
import { cx } from "../../util/classnames.js";

const KIND_ICONS: Record<ToolKind, string> = {
  read: "📄",
  write: "✍️",
  edit: "✏️",
  shell: "💻",
  search: "🔍",
  glob: "🗂️",
  web: "🌐",
  browser: "🖥️",
  notebook: "📓",
  mcp: "🔌",
  todo: "✅",
  other: "🔧",
};

interface Props {
  event: ToolCallEvent;
}

export function ToolCall({ event }: Props) {
  const [expanded, setExpanded] = useState(false);
  const icon = KIND_ICONS[event.toolKind];
  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 text-xs text-fg-muted hover:text-fg-muted transition-colors w-full text-left"
      >
        <span>{icon}</span>
        <span className="font-mono text-fg-muted">{event.toolName}</span>
        <span className="text-fg-subtle truncate flex-1">{event.summary}</span>
        <span className={cx("shrink-0 transition-transform", expanded ? "rotate-90" : "")}>›</span>
      </button>
      {expanded && (
        <pre className="mt-1 text-[11px] text-fg-muted bg-bg-soft rounded p-2 border border-border overflow-x-auto">
          {JSON.stringify(event.input, null, 2)}
        </pre>
      )}
    </div>
  );
}
