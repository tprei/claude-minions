import type { TurnStartedEvent } from "@minions/shared";

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 8);
}

interface Props {
  event: TurnStartedEvent;
}

export function TurnStarted({ event }: Props) {
  return (
    <div className="flex items-center gap-2 my-1.5 opacity-60 select-none">
      <div className="flex-1 border-t border-dotted border-border" />
      <span className="text-[10px] text-fg-subtle">
        turn {event.turn} start
        {event.reason ? ` · ${event.reason}` : ""}
        <span className="font-mono ml-1">· {formatTs(event.timestamp)}</span>
      </span>
      <div className="flex-1 border-t border-dotted border-border" />
    </div>
  );
}
