import { useState } from "react";
import type { ToolCallEvent, ToolKind } from "@minions/shared";
import { CodeBlock } from "../../markdown/CodeBlock.js";
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

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 8);
}

function previewInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return "";
  const [first] = entries;
  if (!first) return "";
  const [k, v] = first;
  const val = typeof v === "string" ? v : JSON.stringify(v);
  const trimmed = val.length > 60 ? `${val.slice(0, 60)}…` : val;
  return `${k}: ${trimmed}`;
}

interface Props {
  event: ToolCallEvent;
}

export function ToolCall({ event }: Props) {
  const [expanded, setExpanded] = useState(false);
  const icon = KIND_ICONS[event.toolKind];
  const summary = event.summary || previewInput(event.input);
  return (
    <div className="my-1 bg-bg-elev border border-border rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full px-2 py-1.5 text-left hover:bg-bg-soft transition-colors"
      >
        <span aria-hidden>{icon}</span>
        <span className="font-mono text-xs text-fg shrink-0">{event.toolName}</span>
        <span className="text-[11px] text-fg-subtle truncate flex-1 min-w-0">{summary}</span>
        <span className="text-[10px] font-mono text-fg-subtle shrink-0">
          {formatTs(event.timestamp)}
        </span>
        <span
          className={cx(
            "text-fg-subtle shrink-0 transition-transform",
            expanded ? "rotate-90" : "",
          )}
        >
          ›
        </span>
      </button>
      {expanded && (
        <CodeBlock code={JSON.stringify(event.input, null, 2)} language="json" />
      )}
    </div>
  );
}
