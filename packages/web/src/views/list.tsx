import { useState, useMemo } from "react";
import type { Session, SessionStatus, SessionMode } from "@minions/shared";
import { useSessionStore } from "../store/sessionStore.js";
import { useConnectionStore } from "../connections/store.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";
import { relTime } from "../util/time.js";
import { cx } from "../util/classnames.js";

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

type FilterStatus = "all" | "running" | "waiting_input" | "completed" | "failed";
type FilterMode = "all" | "task" | "ship" | "dag-task" | "loop";

interface Props {
  filterStatus?: FilterStatus;
  filterMode?: FilterMode;
}

export function ListView({ filterStatus = "all", filterMode = "all" }: Props) {
  const sessionsMap = useSessionStore((s) => s.sessions);
  const activeId = useConnectionStore((s) => s.activeId);
  const [statusFilter, setStatusFilter] = useState<Set<SessionStatus>>(new Set());
  const [modeFilter, setModeFilter] = useState<Set<SessionMode>>(new Set());
  const [search, setSearch] = useState("");

  const sessions = useMemo(() => Array.from(sessionsMap.values()), [sessionsMap]);

  const filtered = useMemo(() => {
    let list = [...sessions].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    if (filterStatus !== "all") {
      list = list.filter((s) => s.status === filterStatus);
    }
    if (filterMode !== "all") {
      list = list.filter((s) => s.mode === filterMode);
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
  }, [sessions, filterStatus, filterMode, statusFilter, modeFilter, search]);

  const navigate = (slug: string) => {
    const { query } = parseUrl();
    if (!activeId) return;
    setUrlState({ connectionId: activeId, view: "list", sessionSlug: slug, query });
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

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="text-sm text-fg-subtle text-center mt-16">No sessions match.</div>
        )}
        <table className="w-full text-sm hidden sm:table">
          <thead className="sticky top-0 bg-bg-soft border-b border-border text-xs text-fg-subtle">
            <tr>
              <th className="text-left px-4 py-2 font-normal">title</th>
              <th className="text-left px-4 py-2 font-normal">mode</th>
              <th className="text-left px-4 py-2 font-normal">status</th>
              <th className="text-left px-4 py-2 font-normal hidden md:table-cell">repo</th>
              <th className="text-left px-4 py-2 font-normal hidden md:table-cell">branch</th>
              <th className="text-left px-4 py-2 font-normal hidden sm:table-cell">attention</th>
              <th className="text-left px-4 py-2 font-normal">updated</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((session) => (
              <SessionRow key={session.slug} session={session} onClick={() => navigate(session.slug)} />
            ))}
          </tbody>
        </table>
        <div className="block sm:hidden p-2 space-y-2">
          {filtered.map((session) => (
            <SessionCard key={session.slug} session={session} onClick={() => navigate(session.slug)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SessionCard({ session, onClick }: { session: Session; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className="card p-3 cursor-pointer hover:border-border transition-colors space-y-2"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm text-fg leading-snug line-clamp-2">{session.title}</span>
        {session.attention.length > 0 && (
          <span className="pill bg-red-900 text-red-300 text-[10px] shrink-0">
            {session.attention.length}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={cx("pill text-[10px]", MODE_COLOR[session.mode])}>
          {session.mode}
        </span>
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
      <div className="text-[10px] text-fg-subtle">{relTime(session.updatedAt)}</div>
    </div>
  );
}

function SessionRow({ session, onClick }: { session: Session; onClick: () => void }) {
  return (
    <tr
      onClick={onClick}
      className="border-b border-border/50 hover:bg-bg-elev cursor-pointer transition-colors"
    >
      <td className="px-4 py-2 max-w-xs truncate text-fg">{session.title}</td>
      <td className="px-4 py-2">
        <span className={cx("pill text-[11px]", MODE_COLOR[session.mode])}>
          {session.mode}
        </span>
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
          <span className="pill bg-red-900 text-red-300 text-[10px]">
            {session.attention.length}
          </span>
        )}
      </td>
      <td className="px-4 py-2 text-fg-subtle text-xs whitespace-nowrap">
        {relTime(session.updatedAt)}
      </td>
    </tr>
  );
}
