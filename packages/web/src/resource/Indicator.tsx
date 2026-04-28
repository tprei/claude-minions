import { useState, useEffect, useRef, type ReactElement } from "react";
import { useResourceStore } from "../store/resourceStore.js";
import { severity, worstSeverity, SEVERITY_COLORS } from "./severity.js";
import { ResourcePanel } from "./Panel.js";
import { cx } from "../util/classnames.js";

interface Props {
  connId: string;
}

function bytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)}GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(0)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

export function ResourceIndicator({ connId }: Props): ReactElement | null {
  const history = useResourceStore(s => s.byConnection.get(connId));
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const latest = history && history.length > 0 ? history[history.length - 1] : null;
  if (!latest) return null;

  const cpuPct = Math.round(latest.cpu.usagePct);
  const memPct = Math.round((latest.memory.usedBytes / Math.max(latest.memory.limitBytes, 1)) * 100);
  const lagMs = Math.round(latest.eventLoop.lagMs);

  const sev = worstSeverity(
    severity(cpuPct, 70, 90),
    severity(memPct, 75, 90),
    severity(lagMs, 100, 250),
  );

  const tooltip = `CPU ${cpuPct}% · MEM ${bytes(latest.memory.rssBytes)} · loop ${lagMs}ms`;

  return (
    <div className="relative" ref={ref}>
      <button
        className={cx(
          "flex items-center gap-1.5 px-2 h-7 rounded-md border border-border bg-bg-soft hover:bg-bg-elev cursor-pointer transition-colors",
          open && "border-accent/60",
        )}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={`Resource usage: ${tooltip}`}
        title={tooltip}
      >
        <span
          className={cx(
            "w-2 h-2 rounded-full",
            SEVERITY_COLORS[sev],
            sev !== "ok" && "animate-pulse",
          )}
          aria-hidden="true"
        />
        <span className="text-[11px] text-fg-muted tabular-nums">{cpuPct}%</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 z-50 shadow-2xl">
          <ResourcePanel connId={connId} />
        </div>
      )}
    </div>
  );
}
