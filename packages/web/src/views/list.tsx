import { useState, useMemo, useRef, useCallback } from "react";
import type { Session, SessionStatus, SessionMode, SessionBucket } from "@minions/shared";
import { formatCostUsd } from "@minions/shared";
import { useSessionStore, EMPTY_SESSIONS } from "../store/sessionStore.js";
import { useConnectionStore, type Connection } from "../connections/store.js";
import { useRootStore } from "../store/root.js";
import { refetchConnection } from "../store/connectionState.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";
import { relTime } from "../util/time.js";
import { cx } from "../util/classnames.js";
import { SessionActionsMenu } from "../chat/SessionActionsMenu.js";
import { usePullToRefresh } from "../pwa/gestures.js";
import { Spinner } from "../components/Spinner.js";

const STATUS_DOT: Record<SessionStatus, string> = {
  pending: "bg-zinc-500",
  running: "bg-green-400 animate-pulse",
  waiting_input: "bg-amber-400 animate-pulse",
  completed: "bg-blue-400",
  failed: "bg-red-500",
  cancelled: "bg-zinc-600",
};

const MODE_COLOR: Record<SessionMode, string> = {
  task: "bg-blue-900 text-blue-300",
  "dag-task": "bg-indigo-900 text-indigo-300",
  plan: "bg-purple-900 text-purple-300",
  think: "bg-violet-900 text-violet-300",
  review: "bg-teal-900 text-teal-300",
  ship: "bg-orange-900 text-orange-300",
  "rebase-resolver": "bg-red-900 text-red-300",
  loop: "bg-green-900 text-green-300",
  "verify-child": "bg-cyan-900 text-cyan-300",
};

const ALL_STATUSES: SessionStatus[] = [
  "pending", "running", "waiting_input", "completed", "failed", "cancelled",
];
const ALL_MODES: SessionMode[] = [
  "task", "dag-task", "plan", "think", "review", "ship", "rebase-resolver", "loop",
];

function toggleSet<T>(set: Set<T>, val: T): Set<T> {
  const next = new Set(set);
  if (next.has(val)) next.delete(val);
  else next.add(val);
  return next;
}

type FilterStatus = "all" | "running" | "waiting_input" | "completed" | "failed" | "attention";
type FilterMode = "all" | "task" | "ship" | "dag-task" | "loop";
type FilterBucket = "all" | SessionBucket;

interface Props {
  filterStatus?: FilterStatus;
  filterMode?: FilterMode;
  filterBucket?: FilterBucket;
}

export function ListView({ filterStatus = "all", filterMode = "all", filterBucket = "all" }: Props) {
  const activeId = useConnectionStore((s) => s.activeId);
  const conn = useRootStore((s) => s.getActiveConnection());
  const sessionsMap = useSessionStore(
    (s) => (activeId ? s.byConnection.get(activeId)?.sessions ?? EMPTY_SESSIONS : EMPTY_SESSIONS),
  );
  const [statusFilter, setStatusFilter] = useState<Set<SessionStatus>>(new Set());
  const [modeFilter, setModeFilter] = useState<Set<SessionMode>>(new Set());
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"updatedAt" | "cost">("updatedAt");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [refreshing, setRefreshing] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const onRefresh = useCallback(async () => {
    if (!conn) return;
    setRefreshing(true);
    try {
      await refetchConnection(conn);
    } finally {
      setRefreshing(false);
    }
  }, [conn]);

  usePullToRefresh(scrollRef, onRefresh);

  const handleSort = (key: "updatedAt" | "cost") => {
    if (sortBy === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(key);
      setSortDir("desc");
    }
  };

  const sessions = useMemo(() => Array.from(sessionsMap.values()), [sessionsMap]);

  const childrenBySlug = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of sessions) {
      if (!s.parentSlug) continue;
      const arr = map.get(s.parentSlug);
      if (arr) arr.push(s.slug);
      else map.set(s.parentSlug, [s.slug]);
    }
    return map;
  }, [sessions]);

  const filtered = useMemo(() => {
    const cmp = (a: Session, b: Session) =>
      sortBy === "cost"
        ? a.stats.costUsd - b.stats.costUsd
        : new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    let list = [...sessions].sort((a, b) => (sortDir === "desc" ? cmp(b, a) : cmp(a, b)));
    if (filterStatus === "attention") {
      list = list.filter((s) => s.attention && s.attention.length > 0);
    } else if (filterStatus !== "all") {
      list = list.filter((s) => s.status === filterStatus);
    }
    if (filterMode !== "all") {
      list = list.filter((s) => s.mode === filterMode);
    }
    if (filterBucket !== "all") {
      list = list.filter((s) => s.bucket === filterBucket);
    }
    if (statusFilter.size > 0) {
      list = list.filter((s) => statusFilter.has(s.status));
    }
    if (modeFilter.size > 0) {
      list = list.filter((s) => modeFilter.has(s.mode));
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.prompt.toLowerCase().includes(q) ||
          (s.branch ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [sessions, filterStatus, filterMode, filterBucket, statusFilter, modeFilter, search, sortBy, sortDir]);

  const navigate = (slug: string) => {
    const { query } = parseUrl();
    if (!activeId) return;
    setUrlState({ connectionId: activeId, view: "list", sessionSlug: slug, query });
  };

  const navigateToDag = (dagId: string) => {
    if (!activeId) return;
    const { query, sessionSlug } = parseUrl();
    setUrlState({ connectionId: activeId, view: "dag", sessionSlug, query: { ...query, dag: dagId } });
  };

  const navigateToParent = (parentSlug: string) => {
    if (!activeId) return;
    const { query } = parseUrl();
    setUrlState({ connectionId: activeId, view: "list", sessionSlug: parentSlug, query });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-border bg-bg-soft">
        <input
          type="search"
          placeholder="Search sessions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input w-52"
        />
        <div className="flex flex-wrap gap-1">
          {ALL_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter((f) => toggleSet(f, s))}
              className={cx(
                "pill text-xs cursor-pointer border",
                statusFilter.has(s)
                  ? "bg-accent text-white border-accent"
                  : "bg-bg-elev text-fg-muted border-border",
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {ALL_MODES.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setModeFilter((f) => toggleSet(f, m))}
              className={cx(
                "pill text-xs cursor-pointer border",
                modeFilter.has(m)
                  ? "bg-accent text-white border-accent"
                  : "bg-bg-elev text-fg-muted border-border",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto relative">
        <div
          aria-hidden={!refreshing}
          className={cx(
            "absolute top-0 left-0 right-0 flex justify-center pointer-events-none transition-transform duration-200 z-10",
            refreshing ? "translate-y-2" : "-translate-y-full",
          )}
        >
          <span className="rounded-full bg-bg-soft border border-border shadow p-1.5">
            <Spinner size="sm" />
          </span>
        </div>
        {filtered.length === 0 ? (
          <EmptyState filterMode={filterMode} filterStatus={filterStatus} />
        ) : (
          <>
            <table className="w-full text-sm hidden sm:table">
              <thead className="sticky top-0 bg-bg-soft border-b border-border text-xs text-fg-subtle">
                <tr>
                  <th className="text-left px-4 py-2 font-normal">title</th>
                  <th className="text-left px-4 py-2 font-normal">mode</th>
                  <th className="text-left px-4 py-2 font-normal">status</th>
                  <th className="text-left px-4 py-2 font-normal hidden md:table-cell">repo</th>
                  <th className="text-left px-4 py-2 font-normal hidden md:table-cell">branch</th>
                  <th className="text-left px-4 py-2 font-normal hidden sm:table-cell">attention</th>
                  <SortableHeader
                    label="cost"
                    sortKey="cost"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                    className="hidden lg:table-cell"
                  />
                  <SortableHeader
                    label="updated"
                    sortKey="updatedAt"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <th className="px-4 py-2 font-normal">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((session) => (
                  <SessionRow
                    key={session.slug}
                    session={session}
                    childSlugs={childrenBySlug.get(session.slug) ?? []}
                    conn={conn}
                    onClick={() => navigate(session.slug)}
                    onOpenDag={navigateToDag}
                    onOpenParent={navigateToParent}
                  />
                ))}
              </tbody>
            </table>
            <div className="block sm:hidden p-2 space-y-2">
              {filtered.map((session) => (
                <SessionCard
                  key={session.slug}
                  session={session}
                  childSlugs={childrenBySlug.get(session.slug) ?? []}
                  conn={conn}
                  onClick={() => navigate(session.slug)}
                  onOpenDag={navigateToDag}
                  onOpenParent={navigateToParent}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface RowCardProps {
  session: Session;
  childSlugs: string[];
  conn: Connection | null;
  onClick: () => void;
  onOpenDag: (dagId: string) => void;
  onOpenParent: (parentSlug: string) => void;
}

function shortSlug(slug: string): string {
  return slug.length > 14 ? `${slug.slice(0, 13)}…` : slug;
}

interface SortableHeaderProps {
  label: string;
  sortKey: "updatedAt" | "cost";
  sortBy: "updatedAt" | "cost";
  sortDir: "desc" | "asc";
  onSort: (key: "updatedAt" | "cost") => void;
  className?: string;
}

function SortableHeader({ label, sortKey, sortBy, sortDir, onSort, className }: SortableHeaderProps) {
  const active = sortBy === sortKey;
  return (
    <th className={cx("text-left px-4 py-2 font-normal", className)}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cx(
          "inline-flex items-center gap-1 cursor-pointer hover:text-fg",
          active && "text-fg",
        )}
      >
        {label}
        {active && <span aria-hidden>{sortDir === "desc" ? "↓" : "↑"}</span>}
      </button>
    </th>
  );
}

function DagPill({ dagId, onOpen }: { dagId: string; onOpen: (dagId: string) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(dagId);
      }}
      title={`Open DAG ${dagId}`}
      className="pill bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300 text-[10px] cursor-pointer hover:bg-indigo-200 dark:hover:bg-indigo-900/60 transition-colors"
    >
      DAG
    </button>
  );
}

function ParentChip({ parentSlug, onOpen }: { parentSlug: string; onOpen: (slug: string) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(parentSlug);
      }}
      title={`Parent: ${parentSlug}`}
      className="pill bg-bg-elev text-fg-muted text-[10px] cursor-pointer hover:text-fg transition-colors font-mono"
    >
      ↑ {shortSlug(parentSlug)}
    </button>
  );
}

function ChildrenChip({ slugs }: { slugs: string[] }) {
  if (slugs.length === 0) return null;
  const preview = slugs.slice(0, 3).join(", ");
  const more = slugs.length > 3 ? ` (+${slugs.length - 3} more)` : "";
  return (
    <span
      onClick={(e) => e.stopPropagation()}
      title={`Children: ${preview}${more}`}
      className="pill bg-bg-elev text-fg-muted text-[10px] font-mono"
    >
      ↓ {slugs.length} {slugs.length === 1 ? "child" : "children"}
    </span>
  );
}

function EmptyState({ filterMode, filterStatus }: { filterMode: FilterMode; filterStatus: FilterStatus }) {
  if (filterStatus === "attention") {
    return (
      <div className="flex flex-col items-center justify-center text-center px-4 mt-16 gap-2">
        <p className="text-sm text-fg-muted max-w-md">Nothing needs attention right now.</p>
        <p className="text-xs text-fg-subtle">Sessions surface here when they are failed, waiting on input, or have CI red.</p>
      </div>
    );
  }
  if (filterMode === "dag-task") {
    return (
      <div className="flex flex-col items-center justify-center text-center px-4 mt-16 gap-3">
        <p className="text-sm text-fg-muted max-w-md">
          No DAG-task sessions yet. DAG-task sessions are children of a DAG plan;
          spawn one from a ship-mode session or via <code className="font-mono text-fg-subtle">/api/sessions</code> with a parent dag.
        </p>
        <p className="text-xs text-fg-subtle">
          Use the <span className="text-fg-muted">All modes</span> filter in the sidebar to reset.
        </p>
      </div>
    );
  }
  return (
    <div className="text-sm text-fg-subtle text-center mt-16">
      No sessions match these filters.
    </div>
  );
}

function SessionCard({ session, childSlugs, conn, onClick, onOpenDag, onOpenParent }: RowCardProps) {
  return (
    <div
      onClick={onClick}
      className="card p-3 cursor-pointer hover:border-border transition-colors space-y-2"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm text-fg leading-snug line-clamp-2">{session.title}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          {session.attention.length > 0 && (
            <span className="pill bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300 text-[10px]">
              {session.attention.length}
            </span>
          )}
          {conn && <SessionActionsMenu session={session} conn={conn} />}
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={cx("pill text-[10px]", MODE_COLOR[session.mode])}>
          {session.mode}
        </span>
        {session.dagId && <DagPill dagId={session.dagId} onOpen={onOpenDag} />}
        {session.parentSlug && <ParentChip parentSlug={session.parentSlug} onOpen={onOpenParent} />}
        <ChildrenChip slugs={childSlugs} />
        <span className="inline-flex items-center gap-1.5 pill bg-bg-elev text-fg-muted text-[10px]">
          <span className={cx("w-2 h-2 rounded-full", STATUS_DOT[session.status])} />
          {session.status}
        </span>
        {session.repoId && (
          <span className="pill bg-bg-elev text-fg-muted text-[10px] truncate max-w-[10rem]">
            {session.repoId}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-[10px] text-fg-subtle">
        <span>{relTime(session.updatedAt)}</span>
        {session.stats.costUsd > 0 && (
          <span className="font-mono text-[10px] text-fg-subtle">
            {formatCostUsd(session.stats.costUsd)}
          </span>
        )}
      </div>
    </div>
  );
}

function SessionRow({ session, childSlugs, conn, onClick, onOpenDag, onOpenParent }: RowCardProps) {
  return (
    <tr
      onClick={onClick}
      className="border-b border-border/50 hover:bg-bg-elev cursor-pointer transition-colors"
    >
      <td className="px-4 py-2 max-w-xs truncate text-fg">{session.title}</td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={cx("pill text-[11px]", MODE_COLOR[session.mode])}>
            {session.mode}
          </span>
          {session.dagId && <DagPill dagId={session.dagId} onOpen={onOpenDag} />}
          {session.parentSlug && <ParentChip parentSlug={session.parentSlug} onOpen={onOpenParent} />}
          <ChildrenChip slugs={childSlugs} />
        </div>
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-1.5">
          <span className={cx("w-2 h-2 rounded-full shrink-0", STATUS_DOT[session.status])} />
          <span className="text-fg-muted text-xs">{session.status}</span>
        </div>
      </td>
      <td className="px-4 py-2 text-fg-subtle text-xs hidden md:table-cell">{session.repoId ?? "—"}</td>
      <td className="px-4 py-2 text-fg-subtle text-xs font-mono hidden md:table-cell truncate max-w-[10rem]">
        {session.branch ?? "—"}
      </td>
      <td className="px-4 py-2 hidden sm:table-cell">
        {session.attention.length > 0 && (
          <span className="pill bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300 text-[10px]">
            {session.attention.length}
          </span>
        )}
      </td>
      <td className="px-4 py-2 text-fg-muted text-xs hidden lg:table-cell font-mono whitespace-nowrap">
        {formatCostUsd(session.stats.costUsd)}
      </td>
      <td className="px-4 py-2 text-fg-subtle text-xs whitespace-nowrap">
        {relTime(session.updatedAt)}
      </td>
      <td className="px-4 py-2 text-right whitespace-nowrap">
        {conn && <SessionActionsMenu session={session} conn={conn} />}
      </td>
    </tr>
  );
}
