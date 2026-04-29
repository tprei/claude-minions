import type { ReactElement } from "react";
import type { LoopDefinition } from "@minions/shared";
import { relTime } from "../util/time.js";
import { cx } from "../util/classnames.js";
import { useLoopsController } from "./loops.js";

interface ApiClient {
  get: (path: string) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  patch: (path: string, body: unknown) => Promise<unknown>;
  del: (path: string) => Promise<unknown>;
}

interface Props {
  api: ApiClient;
  onClose: () => void;
}

const STATUS_DOT_DRAWER: Record<"active" | "disabled" | "failing", string> = {
  active: "bg-green-400",
  disabled: "bg-zinc-500",
  failing: "bg-red-500",
};

function loopStatus(loop: LoopDefinition): "active" | "disabled" | "failing" {
  if (!loop.enabled) return "disabled";
  if (loop.consecutiveFailures > 0) return "failing";
  return "active";
}

export function LoopsDrawer({ api }: Props): ReactElement {
  const { state, retry, cancel, pendingId, actionError } = useLoopsController(api);
  const { loops, loading, error } = state;

  return (
    <div className="flex flex-col gap-3 p-4 text-sm" data-testid="loops-drawer">
      {error && (
        <div className="card p-2 text-xs text-err border border-err/30 bg-err/10">{error}</div>
      )}
      {actionError && (
        <div className="card p-2 text-xs text-err border border-err/30 bg-err/10">{actionError}</div>
      )}
      {loading ? (
        <div className="text-xs text-fg-subtle">Loading…</div>
      ) : loops.length === 0 ? (
        <div className="text-xs text-fg-subtle">
          No loops registered. Define one with <code className="font-mono text-fg-muted">POST /api/loops</code>.
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border-soft" data-testid="loops-drawer-list">
          {loops.map((loop) => {
            const status = loopStatus(loop);
            const isPending = pendingId === loop.id;
            return (
              <li key={loop.id} className="py-2 flex flex-col gap-1" data-testid={`loops-drawer-row-${loop.id}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-fg truncate">{loop.label}</span>
                  <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
                    <span className={cx("w-2 h-2 rounded-full", STATUS_DOT_DRAWER[status])} />
                    {status}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px] text-fg-subtle">
                  <span className="font-mono truncate">{loop.id}</span>
                  <span>{relTime(loop.lastRunAt) || "never run"}</span>
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => void retry(loop.id)}
                    disabled={isPending || loop.enabled}
                    className="pill text-[11px] cursor-pointer border bg-bg-elev text-fg-muted border-border hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed"
                    data-testid={`loops-drawer-retry-${loop.id}`}
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={() => void cancel(loop.id)}
                    disabled={isPending || !loop.enabled}
                    className="pill text-[11px] cursor-pointer border bg-bg-elev text-fg-muted border-border hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed"
                    data-testid={`loops-drawer-cancel-${loop.id}`}
                  >
                    Cancel
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
