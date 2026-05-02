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
import {
  fetchCleanupCandidates,
  executeCleanup,
  previewCleanup,
} from "../../transport/rest.js";
import { CandidateTable } from "./CandidateTable.js";

interface ApiClient {
  get: (path: string) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  patch: (path: string, body: unknown) => Promise<unknown>;
  del: (path: string, body?: unknown) => Promise<unknown>;
}

interface Props {
  api: ApiClient;
  conn: Connection;
}

interface FetchArgs {
  olderThanDays: number;
  statuses: Set<CleanupableStatus>;
  cursor: string | null;
  append: boolean;
}

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 100;

export function CleanupCard({ conn }: Props): ReactElement {
  const [olderThanDays, setOlderThanDays] = useState<number>(7);
  const [statuses, setStatuses] = useState<Set<CleanupableStatus>>(
    () => new Set<CleanupableStatus>(CLEANUPABLE_STATUSES),
  );
  const [candidates, setCandidates] = useState<CleanupCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [removeWorktree, setRemoveWorktree] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastResult, setLastResult] = useState<CleanupExecuteResponse | null>(null);
  const [errorsExpanded, setErrorsExpanded] = useState(false);
  const [selectionBytes, setSelectionBytes] = useState<number | null>(null);

  const fetchMutation = useApiMutation(
    async (args: FetchArgs) => {
      const res = await fetchCleanupCandidates(conn, {
        olderThanDays: args.olderThanDays,
        statuses: Array.from(args.statuses),
        limit: PAGE_SIZE,
        cursor: args.cursor,
      });
      return { res, append: args.append };
    },
    {
      onSuccess: ({ res, append }) => {
        setNextCursor(res.nextCursor);
        if (append) {
          setCandidates((prev) => {
            const seen = new Set(prev.map((c) => c.slug));
            const merged = [...prev];
            for (const c of res.items) if (!seen.has(c.slug)) merged.push(c);
            return merged;
          });
        } else {
          setCandidates(res.items);
          setSelected((prev) => {
            const visible = new Set(res.items.map((i) => i.slug));
            const next = new Set<string>();
            for (const slug of prev) if (visible.has(slug)) next.add(slug);
            return next;
          });
        }
      },
    },
  );

  const previewMutation = useApiMutation(
    async (args: { slugs: string[]; removeWorktree: boolean }) => previewCleanup(conn, args),
    {
      onSuccess: (res) => setSelectionBytes(res.totalBytes),
    },
  );

  const executeMutation = useApiMutation(
    async (args: { slugs: string[]; removeWorktree: boolean }) =>
      executeCleanup(conn, args),
    {
      onSuccess: (res) => {
        setLastResult(res);
        setSelected(new Set());
        setSelectionBytes(null);
        setConfirmOpen(false);
        void fetchMutation.run({ olderThanDays, statuses, cursor: null, append: false });
      },
    },
  );

  const fetchRun = fetchMutation.run;

  useEffect(() => {
    setSelectionBytes(null);
    const timer = setTimeout(() => {
      void fetchRun({ olderThanDays, statuses, cursor: null, append: false });
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

  const toggleStatus = useCallback((s: CleanupableStatus) => {
    setStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }, []);

  const toggleRow = useCallback((slug: string) => {
    setSelectionBytes(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  const toggleAll = useCallback(
    (checked: boolean) => {
      setSelectionBytes(null);
      setSelected(() => (checked ? new Set(candidates.map((c) => c.slug)) : new Set()));
    },
    [candidates],
  );

  const onLoadMore = useCallback(() => {
    if (!nextCursor || fetchMutation.loading) return;
    void fetchRun({ olderThanDays, statuses, cursor: nextCursor, append: true });
  }, [fetchRun, fetchMutation.loading, nextCursor, olderThanDays, statuses]);

  const onComputeSize = useCallback(() => {
    if (selected.size === 0) return;
    void previewMutation.run({ slugs: Array.from(selected), removeWorktree });
  }, [previewMutation, selected, removeWorktree]);

  const onConfirm = useCallback(async () => {
    await executeMutation.run({ slugs: Array.from(selected), removeWorktree });
  }, [executeMutation, selected, removeWorktree]);

  const selectedSlugs = useMemo(() => Array.from(selected), [selected]);

  const isInitialLoading = fetchMutation.loading && candidates.length === 0;
  const isPagingLoading = fetchMutation.loading && candidates.length > 0;

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
      </div>

      {isInitialLoading ? (
        <div className="text-xs text-fg-subtle text-center py-6 border border-dashed border-border rounded-lg">
          Loading candidates…
        </div>
      ) : (
        <CandidateTable
          candidates={candidates}
          selected={selected}
          onToggle={toggleRow}
          onToggleAll={toggleAll}
        />
      )}

      {nextCursor && !isInitialLoading && (
        <div className="flex justify-center pt-1">
          <Button variant="ghost" onClick={onLoadMore} disabled={fetchMutation.loading}>
            {isPagingLoading ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
        <div className="text-xs text-fg-muted flex items-center gap-2 flex-wrap">
          <span>
            <span className="text-fg font-mono">{selected.size}</span> sessions selected
          </span>
          {selectionBytes !== null && (
            <span>
              — <span className="text-fg font-mono">{fmtBytes(selectionBytes)}</span> to reclaim
            </span>
          )}
          {selected.size > 0 && (
            <Button
              variant="ghost"
              onClick={onComputeSize}
              disabled={previewMutation.loading}
            >
              {previewMutation.loading ? "Computing…" : "Compute selection size"}
            </Button>
          )}
          {previewMutation.error && (
            <span className="text-err text-[10px]">{previewMutation.error.message}</span>
          )}
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
        totalBytes={selectionBytes}
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
  totalBytes: number | null;
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
  const sizeLabel = totalBytes === null ? "size not computed" : fmtBytes(totalBytes);

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
          Total to reclaim: <span className="font-mono text-fg">{sizeLabel}</span>
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
            {loading ? "Deleting…" : `Delete ${n} sessions`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
