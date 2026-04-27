import type { ResourceSnapshot } from "@minions/shared";

interface Props {
  snapshot: ResourceSnapshot;
  lagHistory: number[];
}

function bytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function pct(used: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((used / total) * 100);
}

interface SparklineProps {
  values: number[];
  width: number;
  height: number;
  color: string;
}

function Sparkline({ values, width, height, color }: SparklineProps) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);

  const points = values.map((v, i) => {
    const x = i * step;
    const y = height - (v / max) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      aria-hidden
    >
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface BarProps {
  pct: number;
  color: string;
}

function Bar({ pct: p, color }: BarProps) {
  return (
    <div className="h-1.5 rounded-full bg-bg-elev overflow-hidden">
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${p}%`, background: color }}
      />
    </div>
  );
}

export function ResourcePanel({ snapshot, lagHistory }: Props) {
  const { cpu, memory, disk, eventLoop, sessions } = snapshot;
  const cpuPct = Math.round(cpu.usagePct);
  const memPct = pct(memory.usedBytes, memory.limitBytes);
  const diskPct = pct(disk.usedBytes, disk.totalBytes);

  return (
    <div className="card p-4 flex flex-col gap-4 text-sm">
      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-xs text-fg-muted">
          <span>CPU</span>
          <span>{cpuPct}% · {cpu.cores} cores · limit {cpu.limitCores.toFixed(1)}</span>
        </div>
        <Bar pct={cpuPct} color={cpuPct > 80 ? "#ef4444" : "#7c5cff"} />
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-xs text-fg-muted">
          <span>Memory</span>
          <span>{bytes(memory.usedBytes)} / {bytes(memory.limitBytes)} · RSS {bytes(memory.rssBytes)}</span>
        </div>
        <Bar pct={memPct} color={memPct > 85 ? "#ef4444" : "#06b6d4"} />
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-xs text-fg-muted">
          <span>Disk</span>
          <span>{bytes(disk.usedBytes)} / {bytes(disk.totalBytes)}</span>
        </div>
        <Bar pct={diskPct} color={diskPct > 90 ? "#f59e0b" : "#10b981"} />
        <p className="text-[10px] text-fg-subtle truncate">{disk.workspacePath}</p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center text-xs text-fg-muted mb-1">
          <span>Event-loop lag</span>
          <span>{eventLoop.lagMs.toFixed(1)} ms</span>
        </div>
        <Sparkline
          values={lagHistory}
          width={240}
          height={40}
          color={eventLoop.lagMs > 100 ? "#f59e0b" : "#7c5cff"}
        />
      </div>

      <div className="flex gap-4 text-xs text-fg-muted border-t border-border pt-3">
        <span><span className="text-fg-muted font-medium">{sessions.total}</span> total</span>
        <span><span className="text-fg-muted font-medium">{sessions.running}</span> running</span>
        <span><span className="text-fg-muted font-medium">{sessions.waiting}</span> waiting</span>
      </div>
    </div>
  );
}
