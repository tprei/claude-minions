import { useState, useEffect, useRef } from "react";
import type { ResourceSnapshot } from "@minions/shared";
import { cx } from "../util/classnames.js";
import { ResourcePanel } from "./Panel.js";

interface Props {
  snapshot: ResourceSnapshot | null;
}

const LAG_HISTORY_MAX = 60;

export function ResourceIndicator({ snapshot }: Props) {
  const [open, setOpen] = useState(false);
  const [lagHistory, setLagHistory] = useState<number[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!snapshot) return;
    setLagHistory(h => {
      const next = [...h, snapshot.eventLoop.lagMs];
      return next.length > LAG_HISTORY_MAX ? next.slice(-LAG_HISTORY_MAX) : next;
    });
  }, [snapshot]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  if (!snapshot) return null;

  const { cpu, memory, eventLoop, sessions } = snapshot;
  const cpuPct = Math.round(cpu.usagePct);
  const memPct = Math.round((memory.usedBytes / Math.max(memory.limitBytes, 1)) * 100);
  const lagMs = Math.round(eventLoop.lagMs);

  const warn = cpuPct > 80 || memPct > 85 || lagMs > 200;

  return (
    <div className="relative" ref={panelRef}>
      <button
        className={cx(
          "pill border cursor-pointer select-none tabular-nums transition-colors",
          warn
            ? "border-amber-700 bg-amber-900/20 text-amber-300"
            : "border-border bg-bg-soft text-zinc-400 hover:text-zinc-200"
        )}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label="Resource usage"
      >
        <span>{cpuPct}% cpu</span>
        <span className="text-zinc-600">·</span>
        <span>{memPct}% mem</span>
        <span className="text-zinc-600">·</span>
        <span>{lagMs}ms</span>
        <span className="text-zinc-600">·</span>
        <span>{sessions.total}s</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 z-50 shadow-2xl">
          <ResourcePanel snapshot={snapshot} lagHistory={lagHistory} />
        </div>
      )}
    </div>
  );
}
