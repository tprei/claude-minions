import { useMemo } from "react";
import type { Session, SessionStatus, SessionMode } from "@minions/shared";
import { useSessionStore } from "../store/sessionStore.js";
import { useConnectionStore } from "../connections/store.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";
import { relTime } from "../util/time.js";
import { cx } from "../util/classnames.js";

const COLUMNS: { status: SessionStatus; label: string; limit?: number }[] = [
  { status: "pending", label: "Pending" },
  { status: "running", label: "Running" },
  { status: "waiting_input", label: "Waiting input" },
  { status: "completed", label: "Completed", limit: 20 },
  { status: "failed", label: "Failed", limit: 20 },
];

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

const COL_HEADER_BG: Partial<Record<SessionStatus, string>> = {
  running: "bg-green-950/40 border-green-800/40",
  waiting_input: "bg-amber-950/40 border-amber-800/40",
  failed: "bg-red-950/40 border-red-800/40",
};

type FilterStatus = "all" | "running" | "waiting_input" | "completed" | "failed";
type FilterMode = "all" | "task" | "ship" | "dag-task" | "loop";

interface Props {
  filterStatus?: FilterStatus;
  filterMode?: FilterMode;
}

export function KanbanView({ filterStatus = "all", filterMode = "all" }: Props) {
  const sessionsMap = useSessionStore((s) => s.sessions);
  const activeId = useConnectionStore((s) => s.activeId);

  const sessions = useMemo(() => {
    let arr = Array.from(sessionsMap.values());
    if (filterStatus !== "all") arr = arr.filter((s) => s.status === filterStatus);
    if (filterMode !== "all") arr = arr.filter((s) => s.mode === filterMode);
    return arr;
  }, [sessionsMap, filterStatus, filterMode]);

  const byStatus = useMemo(() => {
    const map = new Map<SessionStatus, Session[]>();
    for (const col of COLUMNS) map.set(col.status, []);
    for (const session of sessions) {
      const bucket = map.get(session.status);
      if (bucket) bucket.push(session);
    }
    for (const [, arr] of map) {
      arr.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }
    return map;
  }, [sessions]);

  const navigate = (slug: string) => {
    const { view, query } = parseUrl();
    if (!activeId) return;
    setUrlState({ connectionId: activeId, view, sessionSlug: slug, query });
  };

  return (
    <div className="flex h-full gap-3 p-3 overflow-x-auto snap-x snap-mandatory">
      {COLUMNS.map((col) => {
        const items = byStatus.get(col.status) ?? [];
        const limited = col.limit ? items.slice(0, col.limit) : items;
        const headerClass = COL_HEADER_BG[col.status] ?? "bg-zinc-900/40 border-zinc-700/40";
        return (
          <div key={col.status} className="flex flex-col w-72 shrink-0 snap-start">
            <div className={cx("flex items-center gap-2 rounded-t-lg px-3 py-2 border mb-1", headerClass)}>
              <span className={cx("w-2 h-2 rounded-full", STATUS_DOT[col.status])} />
              <span className="text-sm font-medium text-zinc-200">{col.label}</span>
              <span className="ml-auto text-xs text-zinc-500">{items.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2">
              {limited.map((s) => (
                <KanbanCard key={s.slug} session={s} onClick={() => navigate(s.slug)} />
              ))}
              {col.limit && items.length > col.limit && (
                <div className="text-xs text-zinc-500 text-center py-1">
                  +{items.length - col.limit} more
                </div>
              )}
              {limited.length === 0 && (
                <div className="text-xs text-zinc-600 text-center py-4">empty</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KanbanCard({ session, onClick }: { session: Session; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className="card p-2 cursor-pointer hover:border-zinc-600 transition-colors space-y-1"
    >
      <div className="flex items-start justify-between gap-1.5">
        <span className="text-xs text-zinc-100 leading-snug line-clamp-2">{session.title}</span>
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
        {session.branch && (
          <span className="pill bg-zinc-800 text-zinc-400 text-[10px] font-mono truncate max-w-[8rem]">
            {session.branch}
          </span>
        )}
      </div>
      <div className="text-[10px] text-zinc-500">{relTime(session.updatedAt)}</div>
    </div>
  );
}
