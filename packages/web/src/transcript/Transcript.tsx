import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import type { TranscriptEvent, ToolResultEvent } from "@minions/shared";
import { pickComponent } from "./events/index.js";
import { OrphanedToolResult } from "./events/OrphanedToolResult.js";

const MAX_EVENTS = 500;
const NEAR_BOTTOM_THRESHOLD = 120;

function TurnSeparator({ turn }: { turn: number }) {
  return (
    <div className="flex items-center gap-2 my-1.5 select-none">
      <div className="flex-1 border-t border-dotted border-border" />
      <span className="text-[9px] text-fg-subtle">turn {turn}</span>
      <div className="flex-1 border-t border-dotted border-border" />
    </div>
  );
}

function buildToolCallSet(events: TranscriptEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.kind === "tool_call") ids.add(e.toolCallId);
  }
  return ids;
}

interface Props {
  events: TranscriptEvent[];
}

export function Transcript({ events }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const visible = events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events;
  const toolCallIds = buildToolCallSet(visible);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distFromBottom <= NEAR_BOTTOM_THRESHOLD);
  }, []);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [visible, autoScroll]);

  let lastTurn = -1;
  const rows: ReactNode[] = [];

  for (let i = 0; i < visible.length; i++) {
    const event = visible[i];
    if (event === undefined) continue;

    if (event.turn !== lastTurn && event.kind !== "turn_started") {
      rows.push(<TurnSeparator key={`sep-${event.turn}`} turn={event.turn} />);
      lastTurn = event.turn;
    } else if (event.kind === "turn_started") {
      lastTurn = event.turn;
    }

    let node: ReactNode;

    if (event.kind === "tool_result") {
      const resultEvent = event as ToolResultEvent;
      if (!toolCallIds.has(resultEvent.toolCallId)) {
        node = <OrphanedToolResult key={event.id} event={resultEvent} />;
      } else {
        const Comp = pickComponent(event);
        node = Comp ? <Comp key={event.id} event={event} /> : null;
      }
    } else {
      const Comp = pickComponent(event);
      node = Comp ? <Comp key={event.id} event={event} /> : null;
    }

    if (node) rows.push(node);
  }

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto px-4 py-3 space-y-0.5"
    >
      {events.length === 0 && (
        <div className="text-sm text-fg-subtle text-center mt-12">No events yet.</div>
      )}
      {rows}
      {!autoScroll && (
        <button
          type="button"
          onClick={() => {
            setAutoScroll(true);
            if (containerRef.current) {
              containerRef.current.scrollTop = containerRef.current.scrollHeight;
            }
          }}
          className="fixed bottom-20 right-4 btn text-xs"
        >
          ↓ scroll to bottom
        </button>
      )}
    </div>
  );
}
