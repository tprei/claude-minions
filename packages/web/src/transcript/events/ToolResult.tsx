import type { ToolResultEvent, ToolResultFormat, ToolResultStatus } from "@minions/shared";
import { Markdown } from "../../components/Markdown.js";
import { Diff } from "../../components/Diff.js";
import { cx } from "../../util/classnames.js";

const STATUS_COLORS: Record<ToolResultStatus, string> = {
  ok: "bg-green-900 text-green-300",
  error: "bg-red-900 text-red-300",
  partial: "bg-amber-900 text-amber-300",
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

interface Props {
  event: ToolResultEvent;
}

export function ToolResult({ event }: Props) {
  const fmt = detectFormat(event);
  return (
    <div className="my-0.5 ml-4 border-l-2 border-border pl-3">
      <div className="flex items-center gap-2 mb-1">
        <span className={cx("pill text-[10px]", STATUS_COLORS[event.status])}>
          {event.status}
        </span>
        {event.toolName && (
          <span className="text-[11px] text-fg-subtle font-mono">{event.toolName}</span>
        )}
        {event.truncated && (
          <span className="pill bg-bg-elev text-fg-muted text-[10px]">truncated</span>
        )}
      </div>
      {fmt === "markdown" && <Markdown text={event.body} />}
      {fmt === "diff" && <Diff text={event.body} wrap />}
      {fmt === "json" && (
        <pre className="text-[11px] text-fg-muted bg-bg-soft rounded p-2 border border-border overflow-x-auto">
          {event.body}
        </pre>
      )}
      {fmt === "image" && (
        <img
          src={event.body}
          alt="tool result"
          className="max-w-xs rounded border border-border"
        />
      )}
      {(fmt === "text" || fmt === "binary") && (
        <pre className="text-sm text-fg-muted bg-bg-soft rounded p-2 border border-border whitespace-pre-wrap break-words">
          {event.body}
        </pre>
      )}
    </div>
  );
}
