import { useEffect, useRef, useState, useCallback, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { TranscriptEvent, ToolCallEvent, ToolResultEvent } from "@minions/shared";
import { pickComponent, ToolCall } from "./events/index.js";
import { OrphanedToolResult } from "./events/OrphanedToolResult.js";
import { ToolCallGroup, type ToolCallGroupItem } from "./events/ToolCallGroup.js";
import { WorktreePathContext } from "./events/toolFormat.js";
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

type RenderUnit =
  | { kind: "event"; event: TranscriptEvent }
  | { kind: "single"; call: ToolCallEvent; result?: ToolResultEvent }
  | { kind: "group"; items: ToolCallGroupItem[] }
  | { kind: "orphan-result"; event: ToolResultEvent };

function buildEventGroups(visible: TranscriptEvent[]): RenderUnit[] {
  const resultByCallId = new Map<string, ToolResultEvent>();
  for (const e of visible) {
    if (e.kind === "tool_result") {
      resultByCallId.set(e.toolCallId, e);
    }
  }

  const consumed = new Set<string>();
  const units: RenderUnit[] = [];
  let i = 0;
  while (i < visible.length) {
    const event = visible[i];
    if (event === undefined) {
      i++;
      continue;
    }

    if (event.kind === "tool_call") {
      const cluster: ToolCallGroupItem[] = [];
      let j = i;
      while (j < visible.length) {
        const next = visible[j];
        if (next === undefined) break;
        if (next.kind !== "tool_call") break;
        if (next.toolName !== event.toolName) break;
        if (next.turn !== event.turn) break;
        const result = resultByCallId.get(next.toolCallId);
        cluster.push({ call: next, result });
        consumed.add(next.toolCallId);
        j++;
      }
      if (cluster.length >= 2) {
        units.push({ kind: "group", items: cluster });
      } else {
        const only = cluster[0]!;
        units.push({ kind: "single", call: only.call, result: only.result });
      }
      i = j;
      continue;
    }

    if (event.kind === "tool_result") {
      if (!consumed.has(event.toolCallId)) {
        units.push({ kind: "orphan-result", event });
      }
      i++;
      continue;
    }

    units.push({ kind: "event", event });
    i++;
  }

  return units;
}

function unitTurn(unit: RenderUnit): number {
  switch (unit.kind) {
    case "event":
    case "orphan-result":
      return unit.event.turn;
    case "single":
      return unit.call.turn;
    case "group":
      return unit.items[0]!.call.turn;
  }
}

interface ViewProps {
  events: TranscriptEvent[];
  worktreePath?: string;
}

function TranscriptView({ events }: ViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const visible = events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events;
  const units = buildEventGroups(visible);

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

  for (const unit of units) {
    const turn = unitTurn(unit);
    const isTurnStarted = unit.kind === "event" && unit.event.kind === "turn_started";

    if (turn !== lastTurn && !isTurnStarted) {
      rows.push(<TurnSeparator key={`sep-${turn}`} turn={turn} />);
      lastTurn = turn;
    } else if (isTurnStarted) {
      lastTurn = turn;
    }

    let node: ReactNode = null;
    if (unit.kind === "event") {
      const Comp = pickComponent(unit.event);
      node = Comp ? <Comp key={unit.event.id} event={unit.event} /> : null;
    } else if (unit.kind === "single") {
      node = <ToolCall key={unit.call.id} event={unit.call} result={unit.result} />;
    } else if (unit.kind === "group") {
      node = <ToolCallGroup key={unit.items[0]!.call.id} items={unit.items} />;
    } else {
      node = <OrphanedToolResult key={unit.event.id} event={unit.event} />;
    }

    if (node) rows.push(node);
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
  worktreePath?: string;
}

interface WrapperProps extends Props {
  wrap?: boolean;
}

function TranscriptInner({ events, worktreePath }: Props) {
  const [tab, setTab] = useState<TranscriptTab>("transcript");

  return (
    <WorktreePathContext.Provider value={worktreePath}>
      <div className="flex-1 min-h-0 flex flex-col">
        <TranscriptTabList active={tab} onChange={setTab} />
        <div
          role="tabpanel"
          id={`transcript-tabpanel-${tab}`}
          aria-labelledby={`transcript-tab-${tab}`}
          className="flex-1 min-h-0 flex flex-col"
        >
          {tab === "transcript" ? (
            <TranscriptView events={events} worktreePath={worktreePath} />
          ) : (
            <Timeline events={events} />
          )}
        </div>
      </div>
    </WorktreePathContext.Provider>
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

export function Transcript({ events, worktreePath, wrap = false }: WrapperProps) {
  if (!wrap) return <TranscriptInner events={events} worktreePath={worktreePath} />;
  return <TranscriptStandalone events={events} worktreePath={worktreePath} />;
}

function TranscriptStandalone({ events, worktreePath }: Props) {
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
            <TranscriptInner events={events} worktreePath={worktreePath} />
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
          <TranscriptInner events={events} worktreePath={worktreePath} />
        </div>
      </div>
      <ResizeHandle onDrag={handleDrag} />
    </div>
  );
}
