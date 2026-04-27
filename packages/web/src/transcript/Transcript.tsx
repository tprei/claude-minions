import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import type { TranscriptEvent, ToolCallEvent, ToolResultEvent } from "@minions/shared";
import { pickComponent } from "./events/index.js";
import { OrphanedToolResult } from "./events/OrphanedToolResult.js";
import { ToolCallGroup, type ToolCallGroupItem } from "./events/ToolCallGroup.js";

const MAX_EVENTS = 500;
const JUMP_THRESHOLD = 200;

function TurnDivider() {
  return (
    <div className="flex items-center my-1.5 select-none" aria-hidden="true">
      <div className="flex-1 border-t border-dotted border-border-soft" />
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

interface PendingGroup {
  items: ToolCallGroupItem[];
  orphans: ToolResultEvent[];
}

function emptyGroup(): PendingGroup {
  return { items: [], orphans: [] };
}

function flushGroup(
  group: PendingGroup,
  rows: ReactNode[],
  key: string,
): PendingGroup {
  if (group.items.length > 0) {
    rows.push(<ToolCallGroup key={`${key}-grp`} items={group.items} />);
  }
  for (const orph of group.orphans) {
    rows.push(<OrphanedToolResult key={orph.id} event={orph} />);
  }
  return emptyGroup();
}

export function Transcript({ events }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showJump, setShowJump] = useState(false);

  const visible = events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events;
  const knownCallIds = buildToolCallSet(visible);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const farFromBottom = distFromBottom > JUMP_THRESHOLD;
    setShowJump(farFromBottom);
    setAutoScroll(!farFromBottom);
  }, []);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [visible, autoScroll]);

  const jumpToLatest = useCallback(() => {
    setAutoScroll(true);
    setShowJump(false);
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, []);

  const rows: ReactNode[] = [];
  let lastTurn = -1;
  let group = emptyGroup();
  let groupKey = 0;

  for (let i = 0; i < visible.length; i++) {
    const event = visible[i];
    if (!event) continue;

    if (event.kind === "turn_started" || event.kind === "turn_completed") {
      lastTurn = event.turn;
      continue;
    }

    if (lastTurn !== -1 && event.turn !== lastTurn) {
      group = flushGroup(group, rows, `g${groupKey++}`);
      rows.push(<TurnDivider key={`sep-${event.turn}-${i}`} />);
    }
    lastTurn = event.turn;

    if (event.kind === "tool_call") {
      const call = event as ToolCallEvent;
      group.items.push({ call });
      continue;
    }

    if (event.kind === "tool_result") {
      const result = event as ToolResultEvent;
      const idx = group.items.findIndex(
        (it) => it.call.toolCallId === result.toolCallId && !it.result,
      );
      if (idx >= 0) {
        group.items[idx]!.result = result;
      } else if (knownCallIds.has(result.toolCallId)) {
        group.items.push({
          call: {
            id: `synthetic-${result.toolCallId}`,
            sessionSlug: result.sessionSlug,
            seq: result.seq,
            turn: result.turn,
            timestamp: result.timestamp,
            kind: "tool_call",
            toolCallId: result.toolCallId,
            toolName: result.toolName ?? "tool",
            toolKind: result.toolKind ?? "other",
            summary: "",
            input: {},
          },
          result,
        });
      } else {
        group.orphans.push(result);
      }
      continue;
    }

    group = flushGroup(group, rows, `g${groupKey++}`);

    const Comp = pickComponent(event);
    if (Comp) {
      rows.push(<Comp key={event.id} event={event} />);
    }
  }

  flushGroup(group, rows, `g${groupKey++}`);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5"
      >
        {events.length === 0 && (
          <div className="text-sm text-fg-subtle text-center mt-12">No events yet.</div>
        )}
        {rows}
      </div>
      {showJump && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-4 right-4 btn text-xs shadow-lg"
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}
