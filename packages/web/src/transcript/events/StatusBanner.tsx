import type { StatusEvent } from "@minions/shared";
import { cx } from "../../util/classnames.js";

const LEVEL_STYLES = {
  info: "bg-blue-950 border-blue-700 text-blue-200",
  warn: "bg-amber-950 border-amber-700 text-amber-200",
  error: "bg-red-950 border-red-700 text-red-200",
};

const LEVEL_ICONS = {
  info: "ℹ️",
  warn: "⚠️",
  error: "🚨",
};

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
  return (
    <div className={cx("rounded-lg border px-3 py-2 my-1 text-sm", LEVEL_STYLES[event.level])}>
      <div className="flex items-start gap-2">
        <span>{LEVEL_ICONS[event.level]}</span>
        <span className="flex-1">{event.text}</span>
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
            <div className="text-zinc-300">{verdict.rationale}</div>
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
