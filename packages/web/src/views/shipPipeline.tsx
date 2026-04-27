import type { Session, ShipStage } from "@minions/shared";
import { useSessionStore } from "../store/sessionStore.js";
import { useConnectionStore } from "../connections/store.js";
import { useRootStore } from "../store/root.js";
import { postCommand } from "../transport/rest.js";
import { useFeature } from "../hooks/useFeature.js";
import { UpgradeNotice } from "../components/UpgradeNotice.js";
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

interface SessionPipelineProps {
  session: Session;
}

function ShipPipelineForSession({ session }: SessionPipelineProps) {
  const currentStage = session.shipStage ?? "think";
  const currentIdx = STAGES.indexOf(currentStage);
  const conn = useRootStore((s) => s.getActiveConnection());

  const handleAdvance = async () => {
    if (!conn) return;
    await postCommand(conn, { kind: "ship-advance", sessionSlug: session.slug });
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-zinc-100">{session.title}</h2>
        <p className="text-sm text-zinc-500 mt-1">Ship pipeline · {session.status}</p>
      </div>

      <div className="relative">
        <div className="absolute top-5 left-5 right-5 h-0.5 bg-zinc-700" aria-hidden />
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
                    isPending && "bg-zinc-900 border-zinc-700",
                  )}
                >
                  {isDone ? "✓" : STAGE_ICON[stage]}
                </div>
                <div
                  className={cx(
                    "mt-2 text-xs font-medium",
                    isDone && "text-teal-400",
                    isCurrent && "text-blue-300",
                    isPending && "text-zinc-600",
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
          <span className="font-medium text-zinc-100 capitalize">{currentStage}</span>
          <span className="pill bg-blue-900 text-blue-300 text-[10px] ml-auto">current</span>
        </div>
        <p className="text-sm text-zinc-400">{STAGE_DESC[currentStage]}</p>
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

interface Props {
  sessionSlug?: string | null;
}

export function ShipPipelineView({ sessionSlug }: Props) {
  const enabled = useFeature("ship");
  const sessionsMap = useSessionStore((s) => s.sessions);
  const sessions = Array.from(sessionsMap.values());

  if (!enabled) return <UpgradeNotice feature="ship" />;

  if (!sessionSlug) {
    const shipSessions = sessions.filter((s) => s.mode === "ship");
    return (
      <div className="p-6">
        <h2 className="text-sm font-medium text-zinc-300 mb-4">Ship sessions</h2>
        {shipSessions.length === 0 && (
          <p className="text-sm text-zinc-500">No ship-mode sessions.</p>
        )}
        <div className="space-y-2">
          {shipSessions.map((s) => (
            <div key={s.slug} className="card px-4 py-3">
              <div className="text-sm font-medium text-zinc-100">{s.title}</div>
              <div className="text-xs text-zinc-500">
                {s.slug} · stage: {s.shipStage ?? "think"}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const session = sessionsMap.get(sessionSlug);
  if (!session || session.mode !== "ship") {
    return (
      <div className="p-6 text-sm text-zinc-500">
        Session not found or not in ship mode.
      </div>
    );
  }

  return <ShipPipelineForSession session={session} />;
}
