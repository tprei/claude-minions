import { useState } from "react";
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

const KIND_VERBS: Record<ToolKind, string> = {
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

const KIND_COLOR: Record<ToolKind, string> = {
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

const STATUS_PILLS: Record<ToolResultStatus, { label: string; cls: string }> = {
  ok: { label: "OK", cls: "bg-green-900/40 text-green-400 border-green-800/60" },
  error: { label: "FAIL", cls: "bg-red-900/40 text-red-400 border-red-800/60" },
  partial: {
    label: "partial",
    cls: "bg-amber-900/40 text-amber-400 border-amber-800/60",
  },
};

const PENDING_PILL = {
  label: "…",
  cls: "bg-bg-elev text-fg-subtle border-border",
};

export interface ToolCallGroupItem {
  call: ToolCallEvent;
  result?: ToolResultEvent;
}

interface Props {
  items: ToolCallGroupItem[];
}

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

function ResultBody({ event }: { event: ToolResultEvent }) {
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

function previewFromInput(input: Record<string, unknown>, fallback: string): string {
  const raw = fallback?.trim();
  if (raw) return raw;
  for (const key of [
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "prompt",
    "text",
  ]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function singleLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + "…";
}

function Row({ item }: { item: ToolCallGroupItem }) {
  const [open, setOpen] = useState(false);
  const { call, result } = item;
  const verb = KIND_VERBS[call.toolKind] ?? "Tool";
  const icon = KIND_ICONS[call.toolKind];
  const color = KIND_COLOR[call.toolKind] ?? "text-fg-muted";
  const preview = singleLine(previewFromInput(call.input, call.summary));
  const pill = result ? STATUS_PILLS[result.status] : PENDING_PILL;

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
          {preview}
        </span>
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
        <span className="text-fg-muted font-medium shrink-0">
          {items.length} tool {items.length === 1 ? "call" : "calls"}
        </span>
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
            <Row key={it.call.id} item={it} />
          ))}
        </div>
      )}
    </div>
  );
}
