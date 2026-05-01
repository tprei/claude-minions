import { useState } from "react";
import type { StatusEvent } from "@minions/shared";
import { MarkdownView } from "../../markdown/MarkdownView.js";
import { cx } from "../../util/classnames.js";

const LEVEL_STYLES = {
  info: "bg-tone-info-bg border-tone-info-border text-tone-info-fg",
  warn: "bg-tone-warn-bg border-tone-warn-border text-tone-warn-fg",
  error: "bg-tone-err-bg border-tone-err-border text-tone-err-fg",
};

const LEVEL_ICONS = {
  info: "ℹ️",
  warn: "⚠️",
  error: "🚨",
};

const COLLAPSE_THRESHOLD = 400;

function getVerdict(data: Record<string, unknown>): { winner?: string; rationale?: string; scores?: Record<string, number> } | null {
  if (!("winner" in data) && !("rationale" in data)) return null;
  return {
    winner: typeof data["winner"] === "string" ? data["winner"] : undefined,
    rationale: typeof data["rationale"] === "string" ? data["rationale"] : undefined,
    scores: typeof data["scores"] === "object" && data["scores"] !== null
      ? (data["scores"] as Record<string, number>)
      : undefined,
  };
}

interface Props {
  event: StatusEvent;
}

export function StatusBanner({ event }: Props) {
  const verdict = event.data ? getVerdict(event.data) : null;
  const collapsible = event.text.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);
  const visibleText = collapsible && !expanded
    ? event.text.slice(0, COLLAPSE_THRESHOLD).trimEnd() + "…"
    : event.text;

  return (
    <div className={cx("rounded-lg border px-3 py-2 my-1 text-sm", LEVEL_STYLES[event.level])}>
      <div className="flex items-start gap-2">
        <span>{LEVEL_ICONS[event.level]}</span>
        <div className="flex-1 min-w-0">
          <MarkdownView text={visibleText} />
          {collapsible && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-[11px] underline opacity-80 hover:opacity-100"
            >
              {expanded ? "show less" : "show more"}
            </button>
          )}
        </div>
      </div>
      {verdict && (
        <div className="mt-2 pt-2 border-t border-current/20 space-y-1 text-xs">
          {verdict.winner !== undefined && (
            <div>
              <span className="font-semibold">Winner: </span>
              <span className="font-mono">{verdict.winner}</span>
            </div>
          )}
          {verdict.rationale !== undefined && (
            <div className="text-fg-muted">{verdict.rationale}</div>
          )}
          {verdict.scores !== undefined && (
            <div className="flex gap-3 flex-wrap">
              {Object.entries(verdict.scores).map(([k, v]) => (
                <span key={k} className="font-mono">
                  {k}: {v}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
