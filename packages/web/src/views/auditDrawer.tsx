import { useState, useEffect, useCallback, useMemo, type ReactElement } from "react";
import type { AuditEvent } from "@minions/shared";
import { useConnectionStore } from "../connections/store.js";
import { getAuditEvents } from "../transport/rest.js";
import { EmptyState } from "../components/EmptyState.js";
import { Spinner } from "../components/Spinner.js";

interface Props {
  onClose: () => void;
}

interface PageState {
  items: AuditEvent[];
  nextCursor?: string;
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function formatTarget(target: AuditEvent["target"]): string {
  if (!target) return "—";
  return `${target.kind}:${target.id}`;
}

function previewBody(detail: AuditEvent["detail"]): string {
  if (!detail) return "";
  const json = JSON.stringify(detail);
  return json.length > 80 ? `${json.slice(0, 80)}…` : json;
}

interface RowProps {
  event: AuditEvent;
}

function AuditRow({ event }: RowProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const hasBody = Boolean(event.detail && Object.keys(event.detail).length > 0);

  return (
    <div className="border-b border-border" data-testid="audit-row">
      <button
        type="button"
        className="w-full text-left px-4 py-3 hover:bg-bg-soft transition-colors flex flex-col gap-1"
        onClick={() => hasBody && setExpanded(v => !v)}
        aria-expanded={hasBody ? expanded : undefined}
        aria-label={hasBody ? (expanded ? "Collapse details" : "Expand details") : undefined}
        disabled={!hasBody}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-accent">{event.action}</span>
          <span className="text-[11px] text-fg-subtle whitespace-nowrap">
            {formatTimestamp(event.timestamp)}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <span className="truncate">actor: {event.actor}</span>
          <span className="text-fg-subtle">•</span>
          <span className="truncate">target: {formatTarget(event.target)}</span>
        </div>
        {hasBody && !expanded && (
          <div className="text-[11px] text-fg-subtle font-mono truncate">
            {previewBody(event.detail)}
          </div>
        )}
      </button>
      {hasBody && expanded && (
        <pre
          className="px-4 pb-3 text-[11px] text-fg-muted font-mono whitespace-pre-wrap break-all"
          data-testid="audit-body"
        >
          {JSON.stringify(event.detail, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function AuditDrawer({ onClose }: Props): ReactElement {
  const activeId = useConnectionStore(s => s.activeId);
  const conn = useConnectionStore(s =>
    activeId ? s.connections.find(c => c.id === activeId) ?? null : null,
  );

  const [pages, setPages] = useState<PageState[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = useMemo(() => pages.flatMap(p => p.items), [pages]);
  const lastPage = pages[pages.length - 1];
  const nextCursor = lastPage?.nextCursor;

  const loadFirst = useCallback(async () => {
    if (!conn) {
      setPages([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await getAuditEvents(conn);
      setPages([{ items: res.items, nextCursor: res.nextCursor }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit events");
    } finally {
      setLoading(false);
    }
  }, [conn]);

  const loadMore = useCallback(async () => {
    if (!conn || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await getAuditEvents(conn, nextCursor);
      setPages(prev => [...prev, { items: res.items, nextCursor: res.nextCursor }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more events");
    } finally {
      setLoadingMore(false);
    }
  }, [conn, nextCursor, loadingMore]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  return (
    <div className="flex flex-col h-full" data-testid="audit-drawer">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <h2 className="text-sm font-semibold text-fg-muted flex-1">Audit log</h2>
        <button
          className="btn text-xs"
          onClick={loadFirst}
          disabled={loading}
          aria-label="Refresh"
        >
          {loading ? "…" : "↺"}
        </button>
        <button className="btn p-1.5" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="p-4 text-red-400 text-sm" role="alert">{error}</div>
        )}

        {!conn && !error && (
          <EmptyState title="No connection" description="Pick an active connection to view audit events." />
        )}

        {conn && !error && loading && items.length === 0 && (
          <div className="flex justify-center py-12">
            <Spinner size="md" />
          </div>
        )}

        {conn && !error && !loading && items.length === 0 && (
          <EmptyState title="No audit events" description="Activity will appear here as it happens." />
        )}

        {items.length > 0 && (
          <div role="list" aria-label="Audit events">
            {items.map(ev => (
              <AuditRow key={ev.id} event={ev} />
            ))}
          </div>
        )}

        {nextCursor && (
          <div className="p-4 flex justify-center">
            <button
              type="button"
              className="btn text-xs"
              onClick={loadMore}
              disabled={loadingMore}
              data-testid="audit-load-more"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
