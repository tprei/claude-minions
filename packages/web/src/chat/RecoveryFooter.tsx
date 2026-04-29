// TODO(T33): add web tests for RecoveryFooter once a runner exists.
import { useEffect, useState } from "react";
import type { Command, MergeReadiness, Session, Checkpoint } from "@minions/shared";
import { useRootStore } from "../store/root.js";
import { getCheckpoints, getReadiness, restoreCheckpoint } from "../transport/rest.js";
import { StatusDot } from "../components/StatusDot.js";
import { cx } from "../util/classnames.js";

interface Props {
  session: Session;
  onAction: (cmd: Command) => Promise<void>;
}

const STATUS_LABEL: Record<Session["status"], string> = {
  pending: "Pending",
  running: "Running",
  waiting_input: "Waiting for input",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function readinessTone(r: MergeReadiness): { dot: string; text: string } {
  switch (r.status) {
    case "ready":
      return { dot: "bg-ok", text: "text-ok" };
    case "blocked":
      return { dot: "bg-err", text: "text-err" };
    case "pending":
      return { dot: "bg-warn", text: "text-warn" };
    default:
      return { dot: "bg-fg-subtle", text: "text-fg-subtle" };
  }
}

function readinessOneLiner(r: MergeReadiness): string {
  const blocked = r.checks.filter((c) => c.status === "blocked").map((c) => c.label);
  const warn = r.checks.filter((c) => c.status === "warn").map((c) => c.label);
  if (blocked.length > 0) return `blocked: ${blocked.join(", ")}`;
  if (warn.length > 0) return `warning: ${warn.join(", ")}`;
  if (r.status === "ready") return "all checks passing";
  if (r.status === "pending") return "checks pending";
  return "no readiness signal";
}

interface ActionButtonProps {
  label: string;
  onClick: () => Promise<void> | void;
  disabled?: boolean;
  primary?: boolean;
  title?: string;
}

function ActionButton({ label, onClick, disabled, primary, title }: ActionButtonProps) {
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handle = async () => {
    if (pending || disabled) return;
    setPending(true);
    setErr(null);
    try {
      await onClick();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        type="button"
        title={title ?? label}
        onClick={() => void handle()}
        disabled={disabled || pending}
        className={cx(
          primary ? "btn-primary" : "btn",
          "text-xs px-2 py-1",
          (disabled || pending) && "opacity-50 cursor-not-allowed",
        )}
      >
        {pending ? "…" : label}
      </button>
      {err && <span className="text-[10px] text-err max-w-[160px] truncate" title={err}>Action failed: {err}</span>}
    </div>
  );
}

interface CheckpointButtonProps {
  session: Session;
}

function CheckpointButton({ session }: CheckpointButtonProps) {
  const conn = useRootStore((s) => s.getActiveConnection());
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !conn) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    getCheckpoints(conn, session.slug)
      .then((d) => { if (!cancelled) setItems(d.items); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, conn, session.slug]);

  const handleRestore = async (id: string) => {
    if (!conn) return;
    setPendingId(id);
    setErr(null);
    try {
      await restoreCheckpoint(conn, session.slug, id);
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!conn}
        className={cx("btn text-xs px-2 py-1", !conn && "opacity-50 cursor-not-allowed")}
        title="Restore from checkpoint"
      >
        Restore checkpoint
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute right-0 bottom-full mb-1 z-40 card p-2 shadow-2xl w-64 max-h-72 overflow-y-auto">
            <p className="text-[10px] uppercase tracking-wide text-fg-subtle px-1 pb-1">Recent checkpoints</p>
            {loading && <p className="text-xs text-fg-subtle px-1 py-2">Loading…</p>}
            {!loading && items.length === 0 && (
              <p className="text-xs text-fg-subtle px-1 py-2">No checkpoints.</p>
            )}
            {!loading && items.slice(0, 8).map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={pendingId !== null}
                onClick={() => void handleRestore(c.id)}
                className={cx(
                  "w-full text-left px-2 py-1.5 rounded hover:bg-bg-soft transition-colors",
                  pendingId === c.id && "opacity-60",
                )}
              >
                <div className="font-mono text-[10px] text-fg-muted">{c.sha.slice(0, 8)} · turn {c.turn}</div>
                <div className="text-xs text-fg truncate">{c.message}</div>
              </button>
            ))}
            {err && <p className="text-[10px] text-err px-1 pt-1">Action failed: {err}</p>}
          </div>
        </>
      )}
    </div>
  );
}

export function RecoveryFooter({ session, onAction }: Props) {
  const conn = useRootStore((s) => s.getActiveConnection());
  const [readiness, setReadiness] = useState<MergeReadiness | null>(null);
  const [continueText, setContinueText] = useState("");
  const [continuePending, setContinuePending] = useState(false);
  const [continueErr, setContinueErr] = useState<string | null>(null);

  const visible =
    session.status === "failed" ||
    session.status === "cancelled" ||
    session.status === "completed" ||
    session.attention.length > 0;

  useEffect(() => {
    if (!visible || !conn) return;
    let cancelled = false;
    getReadiness(conn, session.slug)
      .then((r) => { if (!cancelled) setReadiness(r); })
      .catch(() => { if (!cancelled) setReadiness(null); });
    return () => { cancelled = true; };
  }, [visible, conn, session.slug, session.updatedAt]);

  if (!visible) return null;

  const canRetry = session.status === "failed" || session.status === "cancelled";
  const canResume = session.status === "waiting_input";
  const canAbort = session.status === "running" || session.status === "pending" || session.status === "waiting_input";
  const canContinue = session.status === "completed";

  const handleContinue = async () => {
    const text = continueText.trim();
    if (!text || continuePending) return;
    setContinuePending(true);
    setContinueErr(null);
    try {
      await onAction({ kind: "reply", sessionSlug: session.slug, text });
      await onAction({ kind: "resume-session", sessionSlug: session.slug });
      setContinueText("");
    } catch (e) {
      setContinueErr(e instanceof Error ? e.message : String(e));
    } finally {
      setContinuePending(false);
    }
  };

  const tone = readiness ? readinessTone(readiness) : null;
  const flagMsg = session.attention[0]?.message;

  return (
    <div className="border-t border-border bg-bg-elev px-3 py-2 flex flex-col gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <StatusDot status={session.status} size="sm" />
        <span className="text-xs font-medium text-fg-muted">{STATUS_LABEL[session.status]}</span>
        {flagMsg && (
          <span className="text-xs text-fg-subtle truncate" title={flagMsg}>· {flagMsg}</span>
        )}
        {readiness && tone && (
          <span className={cx("flex items-center gap-1 text-xs ml-auto", tone.text)}>
            <span className={cx("inline-block w-1.5 h-1.5 rounded-full", tone.dot)} />
            <span className="truncate" title={readinessOneLiner(readiness)}>{readinessOneLiner(readiness)}</span>
          </span>
        )}
      </div>
      <div className="flex items-start gap-2 justify-end flex-wrap">
        {canRetry && (
          <ActionButton
            label="Retry"
            primary
            title="Send a continuation prompt to retry the last action"
            onClick={() => onAction({ kind: "reply", sessionSlug: session.slug, text: "Please retry the last action." })}
          />
        )}
        {canResume && (
          <ActionButton
            label="Resume"
            primary
            title="Resume from where the agent left off"
            onClick={() => onAction({ kind: "reply", sessionSlug: session.slug, text: "Resume from where you left off." })}
          />
        )}
        {canAbort && (
          <ActionButton
            label="Abort"
            title="Cancel the running session"
            onClick={() => onAction({ kind: "stop", sessionSlug: session.slug })}
          />
        )}
        <CheckpointButton session={session} />
        {session.pr && (
          <a
            href={session.pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn text-xs px-2 py-1"
            title={`Open PR #${session.pr.number}`}
          >
            View PR #{session.pr.number} ↗
          </a>
        )}
      </div>
      {canContinue && (
        <div className="flex flex-col gap-1">
          <textarea
            value={continueText}
            onChange={(e) => setContinueText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void handleContinue();
              }
            }}
            placeholder="Continue this session… (⌘/Ctrl+Enter to send)"
            rows={2}
            disabled={continuePending}
            className="w-full text-xs bg-bg-soft border border-border rounded px-2 py-1 resize-y focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <div className="flex items-center justify-end gap-2">
            {continueErr && (
              <span className="text-[10px] text-err truncate" title={continueErr}>
                Continue failed: {continueErr}
              </span>
            )}
            <button
              type="button"
              onClick={() => void handleContinue()}
              disabled={continuePending || continueText.trim().length === 0}
              className={cx(
                "btn-primary text-xs px-2 py-1",
                (continuePending || continueText.trim().length === 0) && "opacity-50 cursor-not-allowed",
              )}
              title="Reply and resume the session"
            >
              {continuePending ? "Continuing…" : "Continue"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
