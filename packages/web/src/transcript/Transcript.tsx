import { useEffect, useRef, useState, useCallback, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { TranscriptEvent, ToolResultEvent } from "@minions/shared";
import { pickComponent } from "./events/index.js";
import { OrphanedToolResult } from "./events/OrphanedToolResult.js";
import { Timeline } from "./Timeline.js";
import { cx } from "../util/classnames.js";
import { ResizeHandle } from "../components/ResizeHandle.js";
import { Sheet } from "../components/Sheet.js";
import {
  getLayout,
  setLayout,
  getBreakpoint,
  subscribe as subscribePanelLayout,
} from "../util/panelLayout.js";
import { parseUrl } from "../routing/parseUrl.js";
import { subscribeUrlChanges } from "../routing/urlState.js";

const MAX_EVENTS = 500;
const NEAR_BOTTOM_THRESHOLD = 120;

const PANEL_TRANSCRIPT = "transcript";
const TRANSCRIPT_DEFAULT_WIDTH = 640;
const TRANSCRIPT_MIN_WIDTH = 280;
const TRANSCRIPT_MAX_WIDTH = 1400;

function clampTranscriptWidth(n: number): number {
  return Math.max(TRANSCRIPT_MIN_WIDTH, Math.min(TRANSCRIPT_MAX_WIDTH, n));
}

type TranscriptTab = "transcript" | "timeline";

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

interface ViewProps {
  events: TranscriptEvent[];
}

function TranscriptView({ events }: ViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [targetEventId, setTargetEventId] = useState<string | undefined>(
    () => parseUrl().query["event"],
  );
  const lastAppliedTargetRef = useRef<string | undefined>(undefined);

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

  useEffect(() => {
    return subscribeUrlChanges(() => {
      setTargetEventId(parseUrl().query["event"]);
    });
  }, []);

  useEffect(() => {
    if (!targetEventId) return;
    if (lastAppliedTargetRef.current === targetEventId) return;
    if (visible.length === 0) return;
    const container = containerRef.current;
    if (!container) return;
    const el = container.querySelector(`#event-${CSS.escape(targetEventId)}`);
    if (!el) return;
    lastAppliedTargetRef.current = targetEventId;
    setAutoScroll(false);
    el.scrollIntoView({ block: "center" });
  }, [targetEventId, visible]);

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
        node = <OrphanedToolResult event={resultEvent} />;
      } else {
        const Comp = pickComponent(event);
        node = Comp ? <Comp event={event} /> : null;
      }
    } else {
      const Comp = pickComponent(event);
      node = Comp ? <Comp event={event} /> : null;
    }

    if (node) {
      rows.push(
        <div id={`event-${event.id}`} key={event.id}>
          {node}
        </div>,
      );
    }
  }

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5"
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

const TRANSCRIPT_TABS: { id: TranscriptTab; label: string }[] = [
  { id: "transcript", label: "Transcript" },
  { id: "timeline", label: "Timeline" },
];

function TranscriptTabList({
  active,
  onChange,
}: {
  active: TranscriptTab;
  onChange: (id: TranscriptTab) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function activate(idx: number) {
    const tab = TRANSCRIPT_TABS[idx];
    if (!tab) return;
    onChange(tab.id);
    const el = refs.current[idx];
    if (el) el.focus();
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>, idx: number) {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      activate((idx + 1) % TRANSCRIPT_TABS.length);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      activate((idx - 1 + TRANSCRIPT_TABS.length) % TRANSCRIPT_TABS.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      activate(0);
    } else if (e.key === "End") {
      e.preventDefault();
      activate(TRANSCRIPT_TABS.length - 1);
    }
  }

  return (
    <div role="tablist" aria-label="Transcript view" className="flex border-b border-border bg-bg-soft px-2">
      {TRANSCRIPT_TABS.map((tab, idx) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[idx] = el;
            }}
            type="button"
            role="tab"
            id={`transcript-tab-${tab.id}`}
            aria-selected={isActive}
            aria-controls={`transcript-tabpanel-${tab.id}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKeyDown(e, idx)}
            className={cx(
              "px-3 py-1 text-[11px] transition-colors",
              isActive
                ? "text-fg border-b-2 border-accent -mb-px"
                : "text-fg-subtle hover:text-fg-muted",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

interface Props {
  events: TranscriptEvent[];
}

interface WrapperProps extends Props {
  wrap?: boolean;
}

function TranscriptInner({ events }: Props) {
  const [tab, setTab] = useState<TranscriptTab>("transcript");

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TranscriptTabList active={tab} onChange={setTab} />
      <div
        role="tabpanel"
        id={`transcript-tabpanel-${tab}`}
        aria-labelledby={`transcript-tab-${tab}`}
        className="flex-1 min-h-0 flex flex-col"
      >
        {tab === "transcript" ? <TranscriptView events={events} /> : <Timeline events={events} />}
      </div>
    </div>
  );
}

interface WrapperHeaderProps {
  collapsed: boolean;
  onToggle: () => void;
}

function WrapperHeader({ collapsed, onToggle }: WrapperHeaderProps) {
  return (
    <div className="flex items-center justify-between flex-shrink-0 border-b border-border bg-bg-soft px-2 py-1">
      <span className="text-[10px] uppercase tracking-wide text-fg-subtle px-1">Transcript</span>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand transcript" : "Collapse transcript"}
        data-testid="transcript-collapse"
        className="text-[11px] text-fg-subtle hover:text-fg px-1 leading-none"
      >
        {collapsed ? "▸" : "▾"}
      </button>
    </div>
  );
}

export function Transcript({ events, wrap = false }: WrapperProps) {
  if (!wrap) return <TranscriptInner events={events} />;
  return <TranscriptStandalone events={events} />;
}

function TranscriptStandalone({ events }: Props) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const stored = getLayout(PANEL_TRANSCRIPT);
    return stored ? stored.collapsed : false;
  });
  const [width, setWidth] = useState<number>(() => {
    const stored = getLayout(PANEL_TRANSCRIPT);
    return stored ? clampTranscriptWidth(stored.size) : TRANSCRIPT_DEFAULT_WIDTH;
  });
  const [isMobile, setIsMobile] = useState<boolean>(() => getBreakpoint() === "mobile");

  useEffect(() => {
    setLayout(PANEL_TRANSCRIPT, { size: width, collapsed });
  }, [width, collapsed]);

  useEffect(() => {
    return subscribePanelLayout((bp) => {
      setIsMobile(bp === "mobile");
      const stored = getLayout(PANEL_TRANSCRIPT);
      if (!stored) return;
      setWidth(clampTranscriptWidth(stored.size));
      setCollapsed(stored.collapsed);
    });
  }, []);

  const handleDrag = useCallback((delta: number) => {
    setWidth((w) => clampTranscriptWidth(w + delta));
  }, []);

  const toggle = useCallback(() => setCollapsed((c) => !c), []);

  if (isMobile) {
    return (
      <div data-panel="transcript" className="flex flex-col flex-1 min-h-0">
        <WrapperHeader collapsed={collapsed} onToggle={toggle} />
        <Sheet open={!collapsed} onClose={() => setCollapsed(true)} title="Transcript">
          <div className="h-[80vh] flex flex-col">
            <TranscriptInner events={events} />
          </div>
        </Sheet>
      </div>
    );
  }

  if (collapsed) {
    return (
      <div
        data-panel="transcript"
        data-collapsed="true"
        className="flex flex-col flex-shrink-0 border-r border-border bg-bg-soft"
        style={{ width: 36 }}
      >
        <WrapperHeader collapsed={collapsed} onToggle={toggle} />
      </div>
    );
  }

  return (
    <div
      data-panel="transcript"
      className="flex flex-shrink-0 min-h-0 border-r border-border"
      style={{ width }}
    >
      <div className="flex-1 min-w-0 flex flex-col">
        <WrapperHeader collapsed={collapsed} onToggle={toggle} />
        <div data-testid="transcript-body" className="flex-1 min-h-0 flex flex-col">
          <TranscriptInner events={events} />
        </div>
      </div>
      <ResizeHandle onDrag={handleDrag} />
    </div>
  );
}
