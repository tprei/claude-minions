import { useMemo, useState } from "react";
import type { TranscriptEvent, TranscriptEventKind } from "@minions/shared";
import { CodeBlock } from "../markdown/CodeBlock.js";
import { cx } from "../util/classnames.js";
import { copyAsMarkdown, formatTimestamp } from "./copyAsMarkdown.js";

const ALL_KINDS: TranscriptEventKind[] = [
  "user_message",
  "turn_started",
  "turn_completed",
  "assistant_text",
  "thinking",
  "tool_call",
  "tool_result",
  "status",
];

const SNIPPET_MAX = 120;

interface Props {
  events: TranscriptEvent[];
}

function eventSource(event: TranscriptEvent): string {
  if (event.kind === "user_message" && event.source) return event.source;
  if (event.kind === "turn_started" && event.reason) return event.reason;
  if (event.kind === "tool_call") return event.toolName;
  if (event.kind === "tool_result" && event.toolName) return event.toolName;
  if (event.kind === "status") return event.level;
  if (event.kind === "turn_completed") return event.outcome;
  return "";
}

function inlineSnippet(event: TranscriptEvent): string {
  const json = JSON.stringify(event);
  if (json.length <= SNIPPET_MAX) return json;
  return json.slice(0, SNIPPET_MAX - 1) + "…";
}

interface RowProps {
  event: TranscriptEvent;
  expanded: boolean;
  onToggle: () => void;
}

function TimelineRow({ event, expanded, onToggle }: RowProps) {
  const time = formatTimestamp(event.timestamp);
  const source = eventSource(event);
  const snippet = inlineSnippet(event);
  return (
    <div className="border-b border-border-soft">
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left flex items-baseline gap-2 px-3 py-1.5 hover:bg-bg-elev transition-colors font-mono text-[11px]"
      >
        <span className="text-fg-subtle tabular-nums">{time}</span>
        <span className="text-fg">·</span>
        <span className="text-fg-muted whitespace-nowrap">{event.kind}</span>
        <span className="text-fg-subtle">·</span>
        <span className="text-fg-subtle whitespace-nowrap min-w-0 truncate max-w-[12ch]">{source}</span>
        <span className="text-fg-subtle">·</span>
        <span className="text-fg-muted truncate flex-1 min-w-0">{snippet}</span>
        <span className="text-fg-subtle text-[10px] flex-shrink-0">seq {event.seq}</span>
      </button>
      {expanded && (
        <CodeBlock code={JSON.stringify(event, null, 2)} language="json" />
      )}
    </div>
  );
}

interface FilterChipsProps {
  active: Set<TranscriptEventKind>;
  counts: Map<TranscriptEventKind, number>;
  onToggle: (kind: TranscriptEventKind) => void;
}

function FilterChips({ active, counts, onToggle }: FilterChipsProps) {
  return (
    <div className="flex flex-wrap gap-1">
      {ALL_KINDS.map((kind) => {
        const isOn = active.has(kind);
        const count = counts.get(kind) ?? 0;
        return (
          <button
            key={kind}
            type="button"
            onClick={() => onToggle(kind)}
            className={cx(
              "pill border transition-colors text-[10px]",
              isOn
                ? "bg-accent-muted border-accent text-fg"
                : "bg-bg-soft border-border text-fg-subtle hover:text-fg-muted",
            )}
          >
            <span>{kind}</span>
            <span className="text-fg-subtle">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Timeline({ events }: Props) {
  const [activeKinds, setActiveKinds] = useState<Set<TranscriptEventKind>>(
    () => new Set(ALL_KINDS),
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [rangeStart, setRangeStart] = useState<string>("");
  const [rangeEnd, setRangeEnd] = useState<string>("");
  const [toast, setToast] = useState<string | null>(null);

  const counts = useMemo(() => {
    const m = new Map<TranscriptEventKind, number>();
    for (const e of events) m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
    return m;
  }, [events]);

  const sorted = useMemo(() => {
    const arr = events.slice();
    arr.sort((a, b) => a.seq - b.seq);
    return arr;
  }, [events]);

  const filtered = useMemo(
    () => sorted.filter((e) => activeKinds.has(e.kind)),
    [sorted, activeKinds],
  );

  const toggleKind = (kind: TranscriptEventKind) => {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const rangeForCopy = (): TranscriptEvent[] => {
    if (!rangeStart && !rangeEnd) return filtered;
    const startNum = rangeStart ? Number(rangeStart) : Number.NEGATIVE_INFINITY;
    const endNum = rangeEnd ? Number(rangeEnd) : Number.POSITIVE_INFINITY;
    if (Number.isNaN(startNum) || Number.isNaN(endNum)) return filtered;
    return filtered.filter((e) => e.seq >= startNum && e.seq <= endNum);
  };

  const handleCopy = async () => {
    const slice = rangeForCopy();
    const md = copyAsMarkdown(slice);
    try {
      await navigator.clipboard.writeText(md);
      setToast(`Copied ${slice.length} event${slice.length === 1 ? "" : "s"}!`);
    } catch {
      setToast("Copy failed");
    }
    window.setTimeout(() => setToast(null), 2000);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="border-b border-border bg-bg-soft px-3 py-2 space-y-2">
        <FilterChips active={activeKinds} counts={counts} onToggle={toggleKind} />
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-[10px] text-fg-subtle uppercase tracking-wide">Range</label>
          <input
            type="number"
            inputMode="numeric"
            placeholder="start seq"
            value={rangeStart}
            onChange={(e) => setRangeStart(e.target.value)}
            className="input text-xs py-1 w-24"
          />
          <span className="text-fg-subtle text-xs">→</span>
          <input
            type="number"
            inputMode="numeric"
            placeholder="end seq"
            value={rangeEnd}
            onChange={(e) => setRangeEnd(e.target.value)}
            className="input text-xs py-1 w-24"
          />
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleCopy}
            className="btn-primary text-xs"
            disabled={filtered.length === 0}
          >
            Copy as markdown
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto bg-bg">
        {events.length === 0 && (
          <div className="text-sm text-fg-subtle text-center mt-12">No events yet.</div>
        )}
        {events.length > 0 && filtered.length === 0 && (
          <div className="text-sm text-fg-subtle text-center mt-12">No events match the current filters.</div>
        )}
        {filtered.map((event) => (
          <TimelineRow
            key={event.id}
            event={event}
            expanded={expanded.has(event.id)}
            onToggle={() => toggleExpand(event.id)}
          />
        ))}
      </div>
      {toast && (
        <div className="fixed bottom-20 right-4 card px-3 py-2 text-xs shadow-lg z-40">
          {toast}
        </div>
      )}
    </div>
  );
}
