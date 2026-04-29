import { useState } from "react";
import type { ToolResultEvent, ToolResultFormat, ToolResultStatus } from "@minions/shared";
import { MarkdownView } from "../../markdown/MarkdownView.js";
import { CodeBlock } from "../../markdown/CodeBlock.js";
import { Diff } from "../../components/Diff.js";
import { cx } from "../../util/classnames.js";

const STATUS_COLORS: Record<ToolResultStatus, string> = {
  ok: "bg-green-900 text-green-300",
  error: "bg-red-900 text-red-300",
  partial: "bg-amber-900 text-amber-300",
};

const STATUS_GLYPH: Record<ToolResultStatus, string> = {
  ok: "✓",
  error: "✗",
  partial: "…",
};

function detectFormat(event: ToolResultEvent): ToolResultFormat {
  if (event.format !== "text") return event.format;
  const body = event.body;
  if (body.startsWith("---") || /^@@\s+-\d+/.test(body)) return "diff";
  if (body.trimStart().startsWith("{") || body.trimStart().startsWith("[")) {
    try {
      JSON.parse(body);
      return "json";
    } catch {
      // fall through
    }
  }
  return "text";
}

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 8);
}

function previewBody(body: string): string {
  const firstLine = body.split("\n", 1)[0] ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

interface Props {
  event: ToolResultEvent;
}

export function ToolResult({ event }: Props) {
  const [expanded, setExpanded] = useState(false);
  const fmt = detectFormat(event);
  return (
    <div className="my-1 ml-6 bg-bg-elev border border-border rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full px-2 py-1.5 text-left hover:bg-bg-soft transition-colors"
      >
        <span className={cx("pill text-[10px]", STATUS_COLORS[event.status])}>
          <span aria-hidden>{STATUS_GLYPH[event.status]}</span>
          <span>{event.status}</span>
        </span>
        {event.toolName && (
          <span className="font-mono text-[11px] text-fg-muted shrink-0">{event.toolName}</span>
        )}
        <span className="text-[11px] text-fg-subtle truncate flex-1 min-w-0">
          {previewBody(event.body)}
        </span>
        {event.truncated && (
          <span className="pill bg-bg-elev text-fg-muted text-[10px] shrink-0">truncated</span>
        )}
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
        <div className="border-t border-border p-2 font-mono text-xs">
          {fmt === "markdown" && <MarkdownView text={event.body} />}
          {fmt === "diff" && <Diff text={event.body} wrap />}
          {fmt === "json" && <CodeBlock code={event.body} language="json" />}
          {fmt === "image" && (
            <img
              src={event.body}
              alt="tool result"
              className="max-w-xs rounded border border-border"
            />
          )}
          {(fmt === "text" || fmt === "binary") && <CodeBlock code={event.body} />}
        </div>
      )}
    </div>
  );
}
