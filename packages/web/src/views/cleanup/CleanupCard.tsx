import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import {
  CLEANUPABLE_STATUSES,
  type CleanupCandidate,
  type CleanupableStatus,
  type CleanupExecuteResponse,
} from "@minions/shared";
import type { Connection } from "../../connections/store.js";
import { Button } from "../../components/Button.js";
import { Modal } from "../../components/Modal.js";
import { fmtBytes } from "../../util/time.js";
import { useApiMutation } from "../../hooks/useApiMutation.js";
import { useSessionStore } from "../../store/sessionStore.js";
import { fetchCleanupCandidates, executeCleanup } from "../../transport/rest.js";
import { CandidateTable } from "./CandidateTable.js";

interface ApiClient {
  get: (path: string) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  patch: (path: string, body: unknown) => Promise<unknown>;
  del: (path: string) => Promise<unknown>;
}

interface Props {
  api: ApiClient;
  conn: Connection;
}

interface FilterState {
  olderThanDays: number;
  statuses: Set<CleanupableStatus>;
}

const DEBOUNCE_MS = 300;

export function CleanupCard({ conn }: Props): ReactElement {
  const [olderThanDays, setOlderThanDays] = useState<number>(7);
  const [statuses, setStatuses] = useState<Set<CleanupableStatus>>(
    () => new Set<CleanupableStatus>(CLEANUPABLE_STATUSES),
  );
  const [candidates, setCandidates] = useState<CleanupCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [truncated, setTruncated] = useState(false);
  const [removeWorktree, setRemoveWorktree] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastResult, setLastResult] = useState<CleanupExecuteResponse | null>(null);
  const [errorsExpanded, setErrorsExpanded] = useState(false);

  const fetchMutation = useApiMutation(
    async (filter: FilterState) =>
      fetchCleanupCandidates(conn, {
        olderThanDays: filter.olderThanDays,
        statuses: Array.from(filter.statuses),
      }),
    {
      onSuccess: (res) => {
        setCandidates(res.items);
        setTruncated(res.truncated);
        setSelected((prev) => {
          const visible = new Set(res.items.map((i) => i.slug));
          const next = new Set<string>();
          for (const slug of prev) if (visible.has(slug)) next.add(slug);
          return next;
        });
      },
    },
  );

  const executeMutation = useApiMutation(
    async (args: { slugs: string[]; removeWorktree: boolean }) =>
      executeCleanup(conn, args),
    {
      onSuccess: (res) => {
        setLastResult(res);
        setSelected(new Set());
        setConfirmOpen(false);
        void fetchMutation.run({ olderThanDays, statuses });
      },
    },
  );

  const fetchRun = fetchMutation.run;

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchRun({ olderThanDays, statuses });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [olderThanDays, statuses, fetchRun]);

  useEffect(() => {
    if (globalThis.location.hash !== "#cleanup") return;
    const el = document.getElementById("cleanup");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useEffect(() => {
    const unsub = useSessionStore.subscribe((state, prev) => {
      const slice = state.byConnection.get(conn.id);
      const prevSlice = prev.byConnection.get(conn.id);
      if (!slice || !prevSlice) return;
      if (slice.sessions === prevSlice.sessions) return;
      setSelected((prevSel) => {
        let mutated = false;
        const next = new Set<string>();
        for (const slug of prevSel) {
          if (slice.sessions.has(slug)) {
            next.add(slug);
          } else {
            mutated = true;
          }
        }
        return mutated ? next : prevSel;
      });
      setCandidates((prevList) => {
        const filtered = prevList.filter((c) => slice.sessions.has(c.slug));
        return filtered.length === prevList.length ? prevList : filtered;
      });
    });
    return unsub;
  }, [conn.id]);

  const totalSelectedBytes = useMemo(() => {
    let sum = 0;
    for (const c of candidates) if (selected.has(c.slug)) sum += c.worktreeBytes;
    return sum;
  }, [candidates, selected]);

  const toggleStatus = useCallback((s: CleanupableStatus) => {
    setStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }, []);

  const toggleRow = useCallback((slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  const toggleAll = useCallback((checked: boolean) => {
    setSelected(() => (checked ? new Set(candidates.map((c) => c.slug)) : new Set()));
  }, [candidates]);

  const onConfirm = useCallback(async () => {
    await executeMutation.run({ slugs: Array.from(selected), removeWorktree });
  }, [executeMutation, selected, removeWorktree]);

  const selectedSlugs = useMemo(() => Array.from(selected), [selected]);

  return (
    <div id="cleanup" className="card p-4 flex flex-col gap-3 md:col-span-2 scroll-mt-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs uppercase tracking-wider text-fg-subtle">Cleanup</div>
        {fetchMutation.error && (
          <span className="pill bg-err/10 border border-err/30 text-err text-xs">
            {fetchMutation.error.message}
          </span>
        )}
      </div>

      <div className="flex items-center gap-4 flex-wrap text-sm">
        <label className="flex items-center gap-2 text-fg-muted">
          <span className="text-xs">older than (days)</span>
          <input
            type="number"
            min={0}
            value={olderThanDays}
            onChange={(e) => {
              const v = Number(e.target.value);
              setOlderThanDays(Number.isFinite(v) && v >= 0 ? v : 0);
            }}
            className="w-20 px-2 py-1 rounded bg-bg-soft border border-border text-fg text-sm"
          />
        </label>
        <div className="flex items-center gap-3">
          {CLEANUPABLE_STATUSES.map((s) => (
            <label key={s} className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer">
              <input
                type="checkbox"
                checked={statuses.has(s)}
                onChange={() => toggleStatus(s)}
              />
              <span>{s}</span>
            </label>
          ))}
        </div>
        {fetchMutation.loading && (
          <span className="text-xs text-fg-subtle">loading…</span>
        )}
        {truncated && (
          <span className="pill bg-amber-900/30 text-amber-300 text-[10px]">truncated</span>
        )}
      </div>

      <CandidateTable
        candidates={candidates}
        selected={selected}
        onToggle={toggleRow}
        onToggleAll={toggleAll}
      />

      <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
        <div className="text-xs text-fg-muted">
          <span className="text-fg font-mono">{selected.size}</span> sessions selected —{" "}
          <span className="text-fg font-mono">{fmtBytes(totalSelectedBytes)}</span> to reclaim
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer">
            <input
              type="checkbox"
              checked={removeWorktree}
              onChange={(e) => setRemoveWorktree(e.target.checked)}
            />
            <span>Also remove worktree on disk</span>
          </label>
          <Button
            variant="primary"
            disabled={selected.size === 0}
            onClick={() => setConfirmOpen(true)}
          >
            Cleanup…
          </Button>
        </div>
      </div>

      {lastResult && (
        <div className="rounded-lg border border-border bg-bg-soft p-3 text-xs flex flex-col gap-2">
          <div className="text-fg">
            Cleaned up <span className="font-mono">{lastResult.deleted}</span>, reclaimed{" "}
            <span className="font-mono">{fmtBytes(lastResult.bytesReclaimed)}</span>.{" "}
            <span className={lastResult.errors.length > 0 ? "text-err" : "text-fg-subtle"}>
              {lastResult.errors.length} errors.
            </span>
          </div>
          {lastResult.errors.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setErrorsExpanded((v) => !v)}
                className="text-xs text-fg-muted hover:text-fg text-left"
              >
                {errorsExpanded ? "▼" : "▶"} {lastResult.errors.length} error
                {lastResult.errors.length === 1 ? "" : "s"}
              </button>
              {errorsExpanded && (
                <ul className="flex flex-col gap-1 ml-3">
                  {lastResult.errors.map((err) => (
                    <li key={err.slug} className="text-xs">
                      <span className="font-mono text-fg">{err.slug}</span>{" "}
                      <span className="pill bg-err/10 text-err text-[10px]">{err.code}</span>{" "}
                      <span className="text-fg-muted">{err.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      <ConfirmCleanupDialog
        open={confirmOpen}
        slugs={selectedSlugs}
        totalBytes={totalSelectedBytes}
        removeWorktree={removeWorktree}
        loading={executeMutation.loading}
        error={executeMutation.error?.message ?? null}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={onConfirm}
      />
    </div>
  );
}

interface ConfirmProps {
  open: boolean;
  slugs: string[];
  totalBytes: number;
  removeWorktree: boolean;
  loading: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmCleanupDialog({
  open,
  slugs,
  totalBytes,
  removeWorktree,
  loading,
  error,
  onCancel,
  onConfirm,
}: ConfirmProps): ReactElement {
  const n = slugs.length;
  const visible = slugs.slice(0, 10);
  const more = n - visible.length;
  const tail = removeWorktree ? "the git worktrees" : "only the DB rows";

  return (
    <Modal open={open} onClose={onCancel} title={`Clean up ${n} sessions?`}>
      <div className="flex flex-col gap-3 text-sm text-fg">
        <ul className="flex flex-col gap-0.5 max-h-48 overflow-y-auto font-mono text-xs text-fg-muted">
          {visible.map((slug) => (
            <li key={slug}>{slug}</li>
          ))}
          {more > 0 && <li className="text-fg-subtle">…and {more} more</li>}
        </ul>
        <div className="text-xs text-fg-muted">
          Total to reclaim: <span className="font-mono text-fg">{fmtBytes(totalBytes)}</span>
        </div>
        <p className="text-xs text-fg-muted">
          This permanently deletes session DB rows, transcripts, and {tail}. Cannot be undone.
        </p>
        {error && (
          <div className="text-xs text-err border border-err/30 bg-err/10 rounded px-2 py-1">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onCancel} disabled={loading} variant="ghost">
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={loading || n === 0} variant="danger">
            {loading ? "Deleting…" : `Delete ${n} sessions (${fmtBytes(totalBytes)})`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
