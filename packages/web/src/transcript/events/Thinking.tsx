import { useState } from "react";
import type { ThinkingEvent } from "@minions/shared";
import { cx } from "../../util/classnames.js";

interface Props {
  event: ThinkingEvent;
}

export function Thinking({ event }: Props) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-purple-400 hover:text-purple-300 transition-colors"
      >
        <span>🧠 thinking</span>
        <span className={cx("transition-transform", expanded ? "rotate-90" : "")}>›</span>
      </button>
      {expanded && (
        <pre className="mt-1 text-xs text-fg-muted whitespace-pre-wrap bg-bg-soft rounded p-2 border border-border">
          {event.text}
        </pre>
      )}
    </div>
  );
}
