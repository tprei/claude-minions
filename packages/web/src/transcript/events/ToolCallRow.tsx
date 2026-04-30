import { useContext, useState } from "react";
import type {
  ToolCallEvent,
  ToolKind,
  ToolResultEvent,
  ToolResultFormat,
  ToolResultStatus,
} from "@minions/shared";
import { Markdown } from "../../components/Markdown.js";
import { Diff } from "../../components/Diff.js";
import { cx } from "../../util/classnames.js";
import {
  WorktreePathContext,
  formatInlineArg,
  formatResultSummary,
} from "./toolFormat.js";

export const KIND_ICONS: Record<ToolKind, string> = {
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

export const KIND_VERBS: Record<ToolKind, string> = {
  read: "Read file",
  write: "Write file",
  edit: "Edit file",
  shell: "Run shell",
  search: "Search",
  glob: "Find files",
  web: "Fetch web",
  browser: "Browse",
  notebook: "Notebook",
  mcp: "MCP",
  todo: "Update todos",
  other: "Tool",
};

export const KIND_COLOR: Record<ToolKind, string> = {
  read: "text-sky-400",
  write: "text-emerald-400",
  edit: "text-emerald-400",
  shell: "text-violet-400",
  search: "text-amber-400",
  glob: "text-amber-400",
  web: "text-cyan-400",
  browser: "text-cyan-400",
  notebook: "text-pink-400",
  mcp: "text-indigo-400",
  todo: "text-lime-400",
  other: "text-fg-muted",
};

export const STATUS_PILLS: Record<ToolResultStatus, { label: string; cls: string }> = {
  ok: { label: "OK", cls: "bg-green-900/40 text-green-400 border-green-800/60" },
  error: { label: "FAIL", cls: "bg-red-900/40 text-red-400 border-red-800/60" },
  partial: {
    label: "partial",
    cls: "bg-amber-900/40 text-amber-400 border-amber-800/60",
  },
};

export const PENDING_PILL = {
  label: "…",
  cls: "bg-bg-elev text-fg-subtle border-border",
};

const TONE_CLASS: Record<"ok" | "error" | "partial" | "pending", string> = {
  ok: "text-fg-subtle",
  error: "text-red-400",
  partial: "text-amber-400",
  pending: "text-fg-subtle",
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

export function ResultBody({ event }: { event: ToolResultEvent }) {
  const fmt = detectFormat(event);
  if (fmt === "markdown") return <Markdown text={event.body} />;
  if (fmt === "diff") return <Diff text={event.body} wrap />;
  if (fmt === "json") {
    return (
      <pre className="text-[11px] text-fg-muted bg-bg-soft rounded p-2 border border-border overflow-x-auto whitespace-pre-wrap break-words">
        {event.body}
      </pre>
    );
  }
  if (fmt === "image") {
    return (
      <img
        src={event.body}
        alt="tool result"
        className="max-w-xs rounded border border-border"
      />
    );
  }
  return (
    <pre className="text-sm text-fg-muted bg-bg-soft rounded p-2 border border-border whitespace-pre-wrap break-words">
      {event.body}
    </pre>
  );
}

interface Props {
  call: ToolCallEvent;
  result?: ToolResultEvent;
}

export function ToolCallRow({ call, result }: Props) {
  const [open, setOpen] = useState(false);
  const worktreePath = useContext(WorktreePathContext);
  const verb = KIND_VERBS[call.toolKind] ?? "Tool";
  const icon = KIND_ICONS[call.toolKind];
  const color = KIND_COLOR[call.toolKind] ?? "text-fg-muted";
  const arg = formatInlineArg(call.toolName, call.input, { worktreePath });
  const summary = formatResultSummary(call.toolName, result);
  const pill = result ? (STATUS_PILLS[result.status] ?? PENDING_PILL) : PENDING_PILL;

  return (
    <div className="rounded">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left px-1.5 py-0.5 text-[12px] hover:bg-bg-elev/40 rounded"
      >
        <span className={cx("shrink-0 w-4 text-center", color)}>{icon}</span>
        <span className="font-semibold text-fg shrink-0">{verb}</span>
        <span className="truncate flex-1 font-mono text-[11px] text-fg-subtle">
          {arg}
        </span>
        {summary.text && (
          <span className={cx("shrink-0 text-[11px]", TONE_CLASS[summary.tone])}>
            {summary.text}
          </span>
        )}
        <span className={cx("pill border text-[10px] shrink-0", pill.cls)}>
          {pill.label}
        </span>
        <span
          className={cx(
            "shrink-0 text-fg-subtle text-xs transition-transform",
            open ? "rotate-90" : "",
          )}
        >
          ›
        </span>
      </button>
      {open && (
        <div className="px-2 py-1.5 space-y-1.5">
          <pre className="text-[11px] text-fg-muted bg-bg-soft rounded p-2 border border-border overflow-x-auto whitespace-pre-wrap break-words">
            {JSON.stringify(call.input, null, 2)}
          </pre>
          {result && <ResultBody event={result} />}
        </div>
      )}
    </div>
  );
}
