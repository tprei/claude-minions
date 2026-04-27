import type { TurnStartedEvent } from "@minions/shared";

interface Props {
  event: TurnStartedEvent;
}

export function TurnStarted({ event }: Props) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-zinc-600 py-0.5 select-none">
      <span>›</span>
      <span>turn {event.turn} start</span>
      {event.reason && <span className="text-zinc-700">· {event.reason}</span>}
    </div>
  );
}
