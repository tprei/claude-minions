import { useEffect, useState, useCallback, type ReactElement } from "react";
import type { LoopDefinition, ListEnvelope } from "@minions/shared";
import { relTime } from "../util/time.js";
import { cx } from "../util/classnames.js";

interface ApiClient {
  get: (path: string) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  patch: (path: string, body: unknown) => Promise<unknown>;
  del: (path: string) => Promise<unknown>;
}

interface Props {
  api: ApiClient;
}

type LoopStatus = "active" | "disabled" | "failing";

function loopStatus(loop: LoopDefinition): LoopStatus {
  if (!loop.enabled) return "disabled";
  if (loop.consecutiveFailures > 0) return "failing";
  return "active";
}

const STATUS_DOT: Record<LoopStatus, string> = {
  active: "bg-green-400 animate-pulse",
  disabled: "bg-zinc-500",
  failing: "bg-red-500",
};

interface LoopsState {
  loops: LoopDefinition[];
  loading: boolean;
  error: string | null;
}

export function useLoopsController(api: ApiClient): {
  state: LoopsState;
  refresh: () => Promise<void>;
  retry: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  pendingId: string | null;
  actionError: string | null;
} {
  const [state, setState] = useState<LoopsState>({ loops: [], loading: true, error: null });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = (await api.get("/api/loops")) as ListEnvelope<LoopDefinition>;
      setState({ loops: res.items ?? [], loading: false, error: null });
    } catch (err) {
      setState({
        loops: [],
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load loops",
      });
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setEnabled = useCallback(
    async (id: string, enabled: boolean): Promise<void> => {
      setPendingId(id);
      setActionError(null);
      try {
        await api.patch(`/api/loops/${id}/enabled`, { enabled });
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Action failed");
      } finally {
        setPendingId(null);
      }
    },
    [api, refresh],
  );

  const retry = useCallback((id: string) => setEnabled(id, true), [setEnabled]);
  const cancel = useCallback((id: string) => setEnabled(id, false), [setEnabled]);

  return { state, refresh, retry, cancel, pendingId, actionError };
}

export function LoopsView({ api }: Props): ReactElement {
  const { state, retry, cancel, pendingId, actionError } = useLoopsController(api);
  const { loops, loading, error } = state;

  return (
    <div className="h-full overflow-y-auto" data-testid="loops-view">
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-fg">Loops</h1>
          {error && (
            <span className="pill bg-err/10 border border-err/30 text-err text-xs">{error}</span>
          )}
        </div>

        {actionError && (
          <div className="card p-3 text-xs text-err border border-err/30 bg-err/10">{actionError}</div>
        )}

        {loading ? (
          <div className="text-sm text-fg-subtle">Loading loops…</div>
        ) : loops.length === 0 ? (
          <EmptyState hasError={Boolean(error)} />
        ) : (
          <table className="w-full text-sm" data-testid="loops-table">
            <thead className="text-xs text-fg-subtle border-b border-border">
              <tr>
                <th className="text-left px-3 py-2 font-normal">id</th>
                <th className="text-left px-3 py-2 font-normal">name</th>
                <th className="text-left px-3 py-2 font-normal">status</th>
                <th className="text-left px-3 py-2 font-normal">last tick</th>
                <th className="text-right px-3 py-2 font-normal">actions</th>
              </tr>
            </thead>
            <tbody>
              {loops.map((loop) => (
                <LoopRow
                  key={loop.id}
                  loop={loop}
                  pending={pendingId === loop.id}
                  onRetry={() => retry(loop.id)}
                  onCancel={() => cancel(loop.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

interface RowProps {
  loop: LoopDefinition;
  pending: boolean;
  onRetry: () => void;
  onCancel: () => void;
}

function LoopRow({ loop, pending, onRetry, onCancel }: RowProps): ReactElement {
  const status = loopStatus(loop);
  return (
    <tr className="border-b border-border/50" data-testid={`loop-row-${loop.id}`}>
      <td className="px-3 py-2 text-fg-subtle text-xs font-mono">{loop.id}</td>
      <td className="px-3 py-2 text-fg">{loop.label}</td>
      <td className="px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
          <span className={cx("w-2 h-2 rounded-full", STATUS_DOT[status])} />
          {status}
          {loop.consecutiveFailures > 0 && (
            <span className="pill bg-red-900/40 text-red-300 text-[10px]">
              {loop.consecutiveFailures} fail
            </span>
          )}
        </span>
      </td>
      <td className="px-3 py-2 text-fg-subtle text-xs whitespace-nowrap">
        {relTime(loop.lastRunAt) || "—"}
      </td>
      <td className="px-3 py-2 text-right">
        <div className="inline-flex gap-1">
          <button
            type="button"
            onClick={onRetry}
            disabled={pending || loop.enabled}
            className="pill text-xs cursor-pointer border bg-bg-elev text-fg-muted border-border hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid={`loop-retry-${loop.id}`}
          >
            Retry
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={pending || !loop.enabled}
            className="pill text-xs cursor-pointer border bg-bg-elev text-fg-muted border-border hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid={`loop-cancel-${loop.id}`}
          >
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}

function EmptyState({ hasError }: { hasError: boolean }): ReactElement {
  if (hasError) {
    return (
      <div className="text-sm text-fg-subtle">
        Could not load loops. Check the engine connection and retry.
      </div>
    );
  }
  return (
    <div className="text-sm text-fg-subtle">
      No loops registered. Create one with <code className="font-mono text-fg-muted">POST /api/loops</code>.
    </div>
  );
}
