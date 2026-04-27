import type { TurnCompletedEvent } from "@minions/shared";
import { cx } from "../../util/classnames.js";

const OUTCOME_COLORS: Record<TurnCompletedEvent["outcome"], string> = {
  success: "bg-green-900 text-green-300",
  stopped: "bg-bg-elev text-fg-muted",
  errored: "bg-red-900 text-red-300",
  needs_input: "bg-amber-900 text-amber-300",
};

interface Props {
  event: TurnCompletedEvent;
}

export function TurnCompleted({ event }: Props) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className={cx("pill text-[10px]", OUTCOME_COLORS[event.outcome])}>
        {event.outcome}
      </span>
      {event.stopReason && (
        <span className="text-[10px] text-fg-subtle">{event.stopReason}</span>
      )}
    </div>
  );
}
