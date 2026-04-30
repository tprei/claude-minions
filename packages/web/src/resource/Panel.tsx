import type { ReactElement } from "react";
import type { ResourceSnapshot } from "../types.js";
import { useResourceStore } from "../store/resourceStore.js";
import { severity, SEVERITY_STROKES, type Severity } from "./severity.js";
import { ResizeHandle } from "../components/ResizeHandle.js";
import { Sheet } from "../components/Sheet.js";
import { PANEL_RESOURCE, usePanelLayout } from "../util/panelLayout.js";
import { fmtBytes } from "../util/time.js";

interface Props {
  connId: string;
}

const SPARK_WIDTH = 256;
const SPARK_HEIGHT = 36;

const RESOURCE_DEFAULT_WIDTH = 320;
const RESOURCE_MIN_WIDTH = 200;
const RESOURCE_MAX_WIDTH = 720;

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
  domainMax: number;
  color: string;
  label: string;
}

function Sparkline({ values, domainMax, color, label }: SparklineProps): ReactElement {
  if (values.length < 2) {
    return (
      <svg
        width={SPARK_WIDTH}
        height={SPARK_HEIGHT}
        viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
        aria-label={label}
        role="img"
      >
        <line
          x1={0}
          y1={SPARK_HEIGHT - 1}
          x2={SPARK_WIDTH}
          y2={SPARK_HEIGHT - 1}
          stroke="rgb(var(--border))"
          strokeWidth="1"
          strokeDasharray="2 4"
        />
      </svg>
    );
  }

  const max = Math.max(domainMax, 1);
  const step = SPARK_WIDTH / (values.length - 1);

  const points = values.map((v, i) => {
    const x = i * step;
    const clamped = Math.max(0, Math.min(v, max));
    const y = SPARK_HEIGHT - (clamped / max) * (SPARK_HEIGHT - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const areaPoints = `0,${SPARK_HEIGHT} ${points.join(" ")} ${SPARK_WIDTH},${SPARK_HEIGHT}`;

  return (
    <svg
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      aria-label={label}
      role="img"
    >
      <polygon points={areaPoints} fill={color} fillOpacity="0.12" />
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

interface RowProps {
  title: string;
  detail: string;
  values: number[];
  domainMax: number;
  sev: Severity;
}

function Row({ title, detail, values, domainMax, sev }: RowProps): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between items-baseline text-xs">
        <span className="text-fg-muted font-medium">{title}</span>
        <span className="text-fg-subtle tabular-nums">{detail}</span>
      </div>
      <Sparkline
        values={values}
        domainMax={domainMax}
        color={SEVERITY_STROKES[sev]}
        label={`${title} sparkline`}
      />
    </div>
  );
}

function diskFreePct(snap: ResourceSnapshot): number {
  if (snap.disk.totalBytes === 0) return 0;
  return Math.round(((snap.disk.totalBytes - snap.disk.usedBytes) / snap.disk.totalBytes) * 100);
}

function ResourceBody({ connId }: Props): ReactElement {
  const history = useResourceStore(s => s.byConnection.get(connId)) ?? [];
  const latest = history.length > 0 ? history[history.length - 1] : null;

  if (!latest) {
    return (
      <div className="card p-4 text-sm text-fg-muted">
        Waiting for resource data…
      </div>
    );
  }

  const cpuValues = history.map(s => s.cpu.usagePct);
  const memValues = history.map(s => s.memory.rssBytes);
  const lagValues = history.map(s => s.eventLoop.lagMs);
  const diskFreeValues = history.map(diskFreePct);
  const workspaceValues = history.map(s => s.disk.workspaceUsedBytes);

  const cpuPct = Math.round(latest.cpu.usagePct);
  const memPct = pct(latest.memory.usedBytes, latest.memory.limitBytes);
  const diskUsedPct = pct(latest.disk.usedBytes, latest.disk.totalBytes);
  const lagMs = latest.eventLoop.lagMs;

  const cpuSev = severity(cpuPct, 70, 90);
  const memSev = severity(memPct, 75, 90);
  const lagSev = severity(lagMs, 100, 250);
  const diskSev = severity(diskUsedPct, 80, 95);

  const memDomain = Math.max(latest.memory.limitBytes, ...memValues);
  const lagDomain = Math.max(...lagValues, 50);
  const workspaceDomain = Math.max(...workspaceValues, 1);

  return (
    <div className="card p-4 flex flex-col gap-3 text-sm">
      <div className="flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wide text-fg-subtle">Last 60s</span>
        <span className="text-[10px] text-fg-subtle tabular-nums">
          {history.length} sample{history.length === 1 ? "" : "s"}
        </span>
      </div>

      <Row
        title="CPU"
        detail={`${cpuPct}% · ${latest.cpu.cores} cores · limit ${latest.cpu.limitCores.toFixed(1)}`}
        values={cpuValues}
        domainMax={100}
        sev={cpuSev}
      />

      <Row
        title="Memory (RSS)"
        detail={`${bytes(latest.memory.rssBytes)} · used ${bytes(latest.memory.usedBytes)} / ${bytes(latest.memory.limitBytes)}`}
        values={memValues}
        domainMax={memDomain}
        sev={memSev}
      />

      <Row
        title="Event-loop lag"
        detail={`${lagMs.toFixed(1)} ms`}
        values={lagValues}
        domainMax={lagDomain}
        sev={lagSev}
      />

      <Row
        title="Disk free"
        detail={`${bytes(latest.disk.totalBytes - latest.disk.usedBytes)} free · ${diskUsedPct}% used`}
        values={diskFreeValues}
        domainMax={100}
        sev={diskSev}
      />

      <Row
        title="Workspace size"
        detail={fmtBytes(latest.disk.workspaceUsedBytes)}
        values={workspaceValues}
        domainMax={workspaceDomain}
        sev="ok"
      />

      <div className="flex gap-3 text-xs text-fg-muted border-t border-border pt-3 tabular-nums">
        <span><span className="font-medium">{latest.sessions.total}</span> total</span>
        <span><span className="font-medium">{latest.sessions.running}</span> running</span>
        <span><span className="font-medium">{latest.sessions.waiting}</span> waiting</span>
      </div>

      <p className="text-[10px] text-fg-subtle truncate" title={latest.disk.workspacePath}>
        {latest.disk.workspacePath}
      </p>
    </div>
  );
}

export function ResourcePanel({ connId }: Props): ReactElement {
  const { size, collapsed, breakpoint, setSize, toggleCollapsed, setCollapsed } = usePanelLayout(
    PANEL_RESOURCE,
    {
      defaultSize: RESOURCE_DEFAULT_WIDTH,
      minSize: RESOURCE_MIN_WIDTH,
      maxSize: RESOURCE_MAX_WIDTH,
    },
  );
  const isMobile = breakpoint === "mobile";
  const showInline = !collapsed && !isMobile;
  const showSheet = !collapsed && isMobile;

  return (
    <div data-testid="panel-resource" className="flex flex-col">
      <div
        data-testid="panel-resource-header"
        className="flex-shrink-0 flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border bg-bg-soft text-xs"
      >
        <span className="text-fg-subtle font-medium">Resources</span>
        <button
          type="button"
          onClick={toggleCollapsed}
          data-testid="panel-resource-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand resources" : "Collapse resources"}
          className="text-fg-subtle hover:text-fg transition-colors"
        >
          {collapsed ? "▸" : "▾"}
        </button>
      </div>
      {showInline && (
        <div className="flex flex-1 min-h-0">
          <div
            data-testid="panel-resource-body"
            className="flex flex-col min-w-0 overflow-y-auto"
            style={{ width: size }}
          >
            <ResourceBody connId={connId} />
          </div>
          <ResizeHandle
            direction="horizontal"
            onDrag={(delta) => setSize((s) => s + delta)}
          />
        </div>
      )}
      {showSheet && (
        <Sheet
          open
          onClose={() => setCollapsed(true)}
          title="Resources"
          side="bottom"
        >
          <div data-testid="panel-resource-body">
            <ResourceBody connId={connId} />
          </div>
        </Sheet>
      )}
    </div>
  );
}
