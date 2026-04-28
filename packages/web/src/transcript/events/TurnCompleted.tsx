import type { TurnCompletedEvent } from "@minions/shared";
import { cx } from "../../util/classnames.js";

const OUTCOME_DOT: Record<TurnCompletedEvent["outcome"], string> = {
  success: "bg-green-500",
  stopped: "bg-fg-subtle",
  errored: "bg-red-500",
  needs_input: "bg-amber-500",
};

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 8);
}

interface Props {
  event: TurnCompletedEvent;
}

export function TurnCompleted({ event }: Props) {
  return (
    <div className="flex items-center gap-2 my-1.5 opacity-60 select-none">
      <div className="flex-1 border-t border-dotted border-border" />
      <span
        className={cx("inline-block w-1.5 h-1.5 rounded-full shrink-0", OUTCOME_DOT[event.outcome])}
        aria-hidden
      />
      <span className="text-[10px] text-fg-subtle">
        turn {event.turn} · {event.outcome}
        {event.stopReason ? ` (${event.stopReason})` : ""}
        <span className="font-mono ml-1">· {formatTs(event.timestamp)}</span>
      </span>
      <div className="flex-1 border-t border-dotted border-border" />
    </div>
  );
}
