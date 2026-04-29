import { useState } from "react";
import type { ThinkingEvent } from "@minions/shared";
import { MarkdownView } from "../../markdown/MarkdownView.js";
import { cx } from "../../util/classnames.js";

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 8);
}

interface Props {
  event: ThinkingEvent;
}

export function Thinking({ event }: Props) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex items-start gap-2 my-1 opacity-70">
      <div
        className="shrink-0 w-5 h-5 rounded-full bg-bg-soft border border-border text-[10px] flex items-center justify-center"
        aria-label="thinking"
      >
        💭
      </div>
      <div className="flex-1 min-w-0">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-xs italic text-fg-muted hover:text-fg transition-colors"
        >
          <span>thinking</span>
          <span className="not-italic font-mono text-[10px] text-fg-subtle">
            {formatTs(event.timestamp)}
          </span>
          <span className={cx("transition-transform", expanded ? "rotate-90" : "")}>›</span>
        </button>
        {expanded && (
          <div className="mt-1 text-xs italic text-fg-muted bg-bg-soft rounded p-2 border border-border">
            <MarkdownView text={event.text} />
          </div>
        )}
      </div>
    </div>
  );
}
