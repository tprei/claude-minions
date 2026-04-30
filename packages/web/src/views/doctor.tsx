import { useEffect, useRef, useState, type ReactElement } from "react";
import type { DoctorCheck } from "@minions/shared";
import { useRootStore } from "../store/root.js";
import { CleanupCard } from "./cleanup/CleanupCard.js";

interface ApiClient {
  get: (path: string) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  patch: (path: string, body: unknown) => Promise<unknown>;
  del: (path: string) => Promise<unknown>;
}

interface DoctorHealth {
  ok?: boolean;
  time?: string;
}

interface DoctorVersion {
  apiVersion?: string;
  libraryVersion?: string;
  features?: string[];
  provider?: string;
}

interface DoctorSessions {
  total?: number;
  running?: number;
  waiting?: number;
  completed?: number;
  failed?: number;
  [key: string]: number | undefined;
}

interface DoctorPayload {
  health?: DoctorHealth;
  version?: DoctorVersion;
  sessions?: DoctorSessions;
  memoryPending?: number;
  resource?: Record<string, unknown> | null;
  checks?: DoctorCheck[];
}

interface Props {
  api: ApiClient;
}

const REFRESH_MS = 5000;
const SESSION_KEYS: (keyof DoctorSessions)[] = ["running", "waiting", "completed", "failed", "total"];

export function DoctorView({ api }: Props): ReactElement {
  const conn = useRootStore((s) => s.getActiveConnection());
  const [data, setData] = useState<DoctorPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function fetchOnce(): Promise<void> {
      try {
        const result = (await api.get("/api/doctor")) as DoctorPayload;
        if (!mountedRef.current) return;
        setData(result);
        setError(null);
        setLastRefresh(new Date());
      } catch (err) {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to fetch /api/doctor");
        setLastRefresh(new Date());
      }
    }

    void fetchOnce();
    timer = setInterval(() => { void fetchOnce(); }, REFRESH_MS);

    return () => {
      mountedRef.current = false;
      if (timer) clearInterval(timer);
    };
  }, [api]);

  const healthy = data?.health?.ok === true;
  const featureCount = data?.version?.features?.length ?? 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-fg">Doctor</h1>
          {error && (
            <span className="pill bg-err/10 border border-err/30 text-err text-xs">
              {error}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="card p-4 flex flex-col gap-2">
            <div className="text-xs uppercase tracking-wider text-fg-subtle">Health</div>
            <div className="flex items-center gap-2 text-sm text-fg">
              <span
                className={`inline-block w-2.5 h-2.5 rounded-full ${
                  data ? (healthy ? "bg-ok" : "bg-err") : "bg-bg-elev"
                }`}
                aria-hidden
              />
              <span>
                {data ? (healthy ? "ok" : "degraded") : "loading…"}
              </span>
              {data?.health?.time && (
                <span className="text-xs text-fg-subtle ml-auto">
                  {formatTime(data.health.time)}
                </span>
              )}
            </div>
          </div>

          <div className="card p-4 flex flex-col gap-2">
            <div className="text-xs uppercase tracking-wider text-fg-subtle">Version</div>
            <div className="text-sm text-fg flex items-baseline gap-2">
              <span className="font-mono">{data?.version?.libraryVersion ?? "—"}</span>
              <span className="text-xs text-fg-subtle">api {data?.version?.apiVersion ?? "—"}</span>
            </div>
            <div className="text-xs text-fg-muted">
              {featureCount} {featureCount === 1 ? "feature" : "features"}
              {data?.version?.provider && (
                <span className="text-fg-subtle"> · {data.version.provider}</span>
              )}
            </div>
          </div>

          <div className="card p-4 flex flex-col gap-2">
            <div className="text-xs uppercase tracking-wider text-fg-subtle">Sessions</div>
            <div className="flex flex-wrap gap-1.5">
              {SESSION_KEYS.map((key) => {
                const value = data?.sessions?.[key];
                if (typeof value !== "number") return null;
                return (
                  <span key={key} className="pill bg-bg-soft border border-border text-fg-muted text-xs">
                    <span className="text-fg-subtle">{key}</span>
                    <span className="font-mono text-fg">{value}</span>
                  </span>
                );
              })}
              {!data?.sessions && (
                <span className="text-xs text-fg-subtle">loading…</span>
              )}
            </div>
          </div>

          <div className="card p-4 flex flex-col gap-2">
            <div className="text-xs uppercase tracking-wider text-fg-subtle">Memory</div>
            <div className="text-sm text-fg flex items-center gap-2">
              <span className="font-mono">{data?.memoryPending ?? 0}</span>
              <span className="text-xs text-fg-subtle">pending review</span>
            </div>
            <div className="text-xs text-fg-subtle">
              Open via the Memory entry in the sidebar.
            </div>
          </div>

          <div className="card p-4 flex flex-col gap-2 md:col-span-2">
            <div className="text-xs uppercase tracking-wider text-fg-subtle">Resource</div>
            {data?.resource ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {flattenResource(data.resource).map(([key, value]) => (
                  <div key={key} className="flex flex-col">
                    <span className="text-xs text-fg-subtle">{key}</span>
                    <span className="text-sm text-fg font-mono break-all">{value}</span>
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-xs text-fg-subtle">
                {data ? "no resource snapshot" : "loading…"}
              </span>
            )}
          </div>

          {conn && <CleanupCard api={api} conn={conn} />}
        </div>

        {data?.checks && data.checks.length > 0 && (
          <div className="card p-4 flex flex-col gap-2">
            <div className="text-xs uppercase tracking-wider text-fg-subtle">Per-check status</div>
            <div className="flex flex-col divide-y divide-border-soft">
              {data.checks.map((check) => (
                <CheckRow key={check.name} check={check} />
              ))}
            </div>
          </div>
        )}

        <div className="text-xs text-fg-subtle">
          last refresh: {lastRefresh ? formatTime(lastRefresh.toISOString()) : "—"}
        </div>
      </div>
    </div>
  );
}

function CheckRow({ check }: { check: DoctorCheck }): ReactElement {
  const pillClass = STATUS_PILL[check.status] ?? STATUS_PILL.error;
  return (
    <div className="py-2 flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
      <div className="flex items-center gap-2 sm:w-48 shrink-0">
        <span className={`pill text-[11px] ${pillClass}`}>{check.status}</span>
        <span className="text-sm font-mono text-fg">{check.name}</span>
      </div>
      <div className="text-xs text-fg-muted flex-1 break-words">
        {check.detail ?? "—"}
      </div>
      <div className="text-[11px] text-fg-subtle font-mono shrink-0">
        {formatRelative(check.checkedAt)}
      </div>
    </div>
  );
}

const STATUS_PILL: Record<DoctorCheck["status"], string> = {
  ok: "bg-ok/10 border border-ok/30 text-ok",
  degraded: "bg-warn/10 border border-warn/30 text-warn",
  error: "bg-err/10 border border-err/30 text-err",
};

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const deltaSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (deltaSec < 5) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const min = Math.round(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString();
}

function flattenResource(resource: Record<string, unknown>, prefix = ""): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(resource)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) {
      out.push([path, "—"]);
    } else if (typeof value === "object" && !Array.isArray(value)) {
      out.push(...flattenResource(value as Record<string, unknown>, path));
    } else if (Array.isArray(value)) {
      out.push([path, JSON.stringify(value)]);
    } else if (typeof value === "number") {
      out.push([path, formatNumber(path, value)]);
    } else {
      out.push([path, String(value)]);
    }
  }
  return out;
}

function formatNumber(path: string, value: number): string {
  const lower = path.toLowerCase();
  if (lower.endsWith("bytes")) return formatBytes(value);
  if (lower.endsWith("pct")) return `${value.toFixed(1)}%`;
  if (lower.endsWith("ms")) return `${value.toFixed(1)} ms`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
