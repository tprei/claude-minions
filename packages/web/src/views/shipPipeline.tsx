import { useMemo } from "react";
import type { Session, SessionStatus, ShipStage } from "@minions/shared";
import { useSessionStore, EMPTY_SESSIONS } from "../store/sessionStore.js";
import { useConnectionStore } from "../connections/store.js";
import { useRootStore } from "../store/root.js";
import { postCommand } from "../transport/rest.js";
import { useFeature } from "../hooks/useFeature.js";
import { UpgradeNotice } from "../components/UpgradeNotice.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";
import { relTime } from "../util/time.js";
import { cx } from "../util/classnames.js";

const STAGES: ShipStage[] = ["think", "plan", "dag", "verify", "done"];

const STAGE_DESC: Record<ShipStage, string> = {
  think: "Analyzing the problem and generating an approach.",
  plan: "Writing a detailed execution plan.",
  dag: "Building and running the task DAG.",
  verify: "Running quality checks and readiness gates.",
  done: "All stages complete.",
};

const STAGE_ICON: Record<ShipStage, string> = {
  think: "💭",
  plan: "📋",
  dag: "🗂️",
  verify: "✅",
  done: "🚀",
};

const STAGE_COL_CLASS: Record<ShipStage, string> = {
  think: "bg-violet-950/40 border-violet-800/40",
  plan: "bg-purple-950/40 border-purple-800/40",
  dag: "bg-indigo-950/40 border-indigo-800/40",
  verify: "bg-blue-950/40 border-blue-800/40",
  done: "bg-emerald-950/40 border-emerald-800/40",
};

const STATUS_DOT: Record<SessionStatus, string> = {
  pending: "bg-zinc-500",
  running: "bg-green-400 animate-pulse",
  waiting_input: "bg-amber-400 animate-pulse",
  completed: "bg-blue-400",
  failed: "bg-red-500",
  cancelled: "bg-zinc-600",
};

const PR_STATE_PILL: Record<"open" | "closed" | "merged", string> = {
  open: "bg-emerald-900/40 text-emerald-300",
  merged: "bg-purple-900/40 text-purple-300",
  closed: "bg-bg-elev text-fg-muted",
};

interface SessionPipelineProps {
  session: Session;
}

function ShipPipelineForSession({ session }: SessionPipelineProps) {
  const currentStage = session.shipStage ?? "think";
  const currentIdx = STAGES.indexOf(currentStage);
  const conn = useRootStore((s) => s.getActiveConnection());
  const activeId = useConnectionStore((s) => s.activeId);

  const handleAdvance = async () => {
    if (!conn) return;
    await postCommand(conn, { kind: "ship-advance", sessionSlug: session.slug });
  };

  const navigateToBoard = () => {
    if (!activeId) return;
    const { query } = parseUrl();
    setUrlState({ connectionId: activeId, view: "ship", sessionSlug: null, query });
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="mb-4">
        <button
          type="button"
          onClick={navigateToBoard}
          className="text-xs text-fg-subtle hover:text-fg-muted"
        >
          ← Ship board
        </button>
      </div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-fg">{session.title}</h2>
        <p className="text-sm text-fg-subtle mt-1">Ship pipeline · {session.status}</p>
      </div>

      <div className="relative">
        <div className="absolute top-5 left-5 right-5 h-0.5 bg-bg-elev" aria-hidden />
        <div className="relative flex justify-between gap-2">
          {STAGES.map((stage, idx) => {
            const isDone = idx < currentIdx;
            const isCurrent = idx === currentIdx;
            const isPending = idx > currentIdx;
            return (
              <div key={stage} className="flex flex-col items-center flex-1 z-10">
                <div
                  className={cx(
                    "w-10 h-10 rounded-full flex items-center justify-center text-lg border-2 transition-colors",
                    isDone && "bg-teal-900 border-teal-500",
                    isCurrent && "bg-blue-900 border-blue-400 ring-2 ring-blue-400/30",
                    isPending && "bg-bg-soft border-border",
                  )}
                >
                  {isDone ? "✓" : STAGE_ICON[stage]}
                </div>
                <div
                  className={cx(
                    "mt-2 text-xs font-medium",
                    isDone && "text-teal-400",
                    isCurrent && "text-blue-300",
                    isPending && "text-fg-subtle",
                  )}
                >
                  {stage}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-8 card p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xl">{STAGE_ICON[currentStage]}</span>
          <span className="font-medium text-fg capitalize">{currentStage}</span>
          <span className="pill bg-blue-900 text-blue-300 text-[10px] ml-auto">current</span>
        </div>
        <p className="text-sm text-fg-muted">{STAGE_DESC[currentStage]}</p>
      </div>

      {currentStage !== "done" && session.status !== "running" && (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={handleAdvance}
            className="btn-primary"
          >
            Advance →
          </button>
        </div>
      )}
    </div>
  );
}

interface BoardCardProps {
  session: Session;
  onOpen: () => void;
}

function ShipBoardCard({ session, onOpen }: BoardCardProps) {
  return (
    <div
      onClick={onOpen}
      className="card p-3 hover:bg-bg-elev cursor-pointer transition-colors space-y-1.5"
    >
      <div className="flex items-start gap-1.5">
        <span className={cx("w-2 h-2 mt-1 rounded-full shrink-0", STATUS_DOT[session.status])} />
        <span className="text-xs text-fg leading-snug line-clamp-2 flex-1">{session.title}</span>
        {session.attention.length > 0 && (
          <span
            className="pill bg-red-900 text-red-300 text-[10px] shrink-0"
            title={session.attention.map((a) => a.message).join("\n")}
          >
            {session.attention.length}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
        {session.branch && (
          <span className="pill bg-bg-elev text-fg-muted font-mono truncate max-w-[10rem]">
            {session.branch}
          </span>
        )}
        {session.pr && (
          <a
            href={session.pr.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={session.pr.title}
            className={cx("pill font-mono hover:underline", PR_STATE_PILL[session.pr.state])}
          >
            PR #{session.pr.number} · {session.pr.state}{session.pr.draft ? " (draft)" : ""}
          </a>
        )}
        {session.dagId && (
          <span className="pill bg-indigo-900/40 text-indigo-300 font-mono" title={`DAG ${session.dagId}`}>
            DAG
          </span>
        )}
      </div>
      <div className="text-[10px] text-fg-muted">{relTime(session.updatedAt)}</div>
    </div>
  );
}

interface BoardProps {
  sessions: Session[];
}

function ShipBoard({ sessions }: BoardProps) {
  const activeId = useConnectionStore((s) => s.activeId);

  const byStage = useMemo(() => {
    const map = new Map<ShipStage, Session[]>();
    for (const stage of STAGES) map.set(stage, []);
    for (const s of sessions) {
      const stage = s.shipStage ?? "think";
      const bucket = map.get(stage);
      if (bucket) bucket.push(s);
    }
    for (const [, arr] of map) {
      arr.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }
    return map;
  }, [sessions]);

  const openSession = (slug: string) => {
    if (!activeId) return;
    const { query } = parseUrl();
    setUrlState({ connectionId: activeId, view: "ship", sessionSlug: slug, query });
  };

  if (sessions.length === 0) {
    return (
      <div className="p-6">
        <h2 className="text-sm font-medium text-fg-muted mb-2">Ship board</h2>
        <p className="text-sm text-fg-subtle">No ship-mode sessions.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-border flex items-center gap-2">
        <h2 className="text-sm font-medium text-fg-muted">Ship board</h2>
        <span className="text-xs text-fg-subtle">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex-1 flex gap-3 p-3 overflow-x-auto snap-x snap-mandatory">
        {STAGES.map((stage) => {
          const items = byStage.get(stage) ?? [];
          return (
            <div key={stage} className="flex flex-col w-[calc(100vw-2rem)] sm:w-72 shrink-0 snap-start">
              <div
                className={cx(
                  "flex items-center gap-2 rounded-t-lg px-3 py-2 border mb-1",
                  STAGE_COL_CLASS[stage],
                )}
              >
                <span className="text-base leading-none">{STAGE_ICON[stage]}</span>
                <span className="text-sm font-medium text-fg-muted capitalize">{stage}</span>
                <span className="ml-auto text-xs text-fg-subtle">{items.length}</span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2">
                {items.map((s) => (
                  <ShipBoardCard key={s.slug} session={s} onOpen={() => openSession(s.slug)} />
                ))}
                {items.length === 0 && (
                  <div className="text-xs text-fg-subtle text-center py-4">empty</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface Props {
  sessionSlug?: string | null;
}

export function ShipPipelineView({ sessionSlug }: Props) {
  const enabled = useFeature("ship");
  const activeId = useConnectionStore((s) => s.activeId);
  const sessionsMap = useSessionStore(
    (s) => (activeId ? s.byConnection.get(activeId)?.sessions ?? EMPTY_SESSIONS : EMPTY_SESSIONS),
  );

  if (!enabled) return <UpgradeNotice feature="ship" />;

  if (!sessionSlug) {
    const shipSessions = Array.from(sessionsMap.values()).filter((s) => s.mode === "ship");
    return <ShipBoard sessions={shipSessions} />;
  }

  const session = sessionsMap.get(sessionSlug);
  if (!session || session.mode !== "ship") {
    return (
      <div className="p-6 text-sm text-fg-subtle">
        Session not found or not in ship mode.
      </div>
    );
  }

  return <ShipPipelineForSession session={session} />;
}
