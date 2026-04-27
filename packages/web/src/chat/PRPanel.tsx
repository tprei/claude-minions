import { useCallback, useEffect, useState } from "react";
import type { Session, PullRequestPreview, CheckRun, CheckConclusion } from "@minions/shared";
import { getPR, postCommand } from "../transport/rest.js";
import { useRootStore } from "../store/root.js";
import { Spinner } from "../components/Spinner.js";
import { cx } from "../util/classnames.js";

const STATE_PILL: Record<"open" | "merged" | "closed" | "draft", string> = {
  open: "bg-ok/15 text-ok border border-ok/30",
  merged: "bg-accent-muted text-accent border border-accent/30",
  closed: "bg-err/15 text-err border border-err/30",
  draft: "bg-bg-elev text-fg-subtle border border-border",
};

function statePillLabel(pr: PullRequestPreview): "open" | "merged" | "closed" | "draft" {
  if (pr.draft) return "draft";
  return pr.state;
}

const CONCLUSION_COLOR: Record<CheckConclusion, string> = {
  success: "bg-ok",
  failure: "bg-err",
  neutral: "bg-zinc-500",
  cancelled: "bg-zinc-500",
  skipped: "bg-zinc-500",
  timed_out: "bg-err",
  action_required: "bg-warn",
  stale: "bg-zinc-500",
  pending: "bg-warn",
};

function CheckStatusIcon({ check }: { check: CheckRun }) {
  if (check.status === "queued") {
    return <span aria-label="queued" className="inline-block w-2 h-2 rounded-full bg-zinc-500 flex-shrink-0" />;
  }
  if (check.status === "in_progress") {
    return <span aria-label="in_progress" className="inline-block w-2 h-2 rounded-full bg-warn animate-pulse flex-shrink-0" />;
  }
  const color = check.conclusion ? CONCLUSION_COLOR[check.conclusion] : "bg-zinc-500";
  return <span aria-label={check.conclusion ?? "completed"} className={cx("inline-block w-2 h-2 rounded-full flex-shrink-0", color)} />;
}

function formatDuration(check: CheckRun): string | null {
  if (!check.startedAt) return null;
  const start = Date.parse(check.startedAt);
  if (Number.isNaN(start)) return null;
  const end = check.completedAt ? Date.parse(check.completedAt) : Date.now();
  if (Number.isNaN(end)) return null;
  const ms = Math.max(0, end - start);
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem === 0 ? `${min}m` : `${min}m ${rem}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin === 0 ? `${hr}h` : `${hr}h ${remMin}m`;
}

function reviewLabel(decision: PullRequestPreview["reviewDecision"]): string | null {
  if (!decision) return null;
  if (decision === "APPROVED") return "approved";
  if (decision === "CHANGES_REQUESTED") return "changes requested";
  if (decision === "REVIEW_REQUIRED") return "review required";
  return null;
}

function mergeLabel(pr: PullRequestPreview): string | null {
  if (pr.mergeable === true) return "mergeable";
  if (pr.mergeable === false) return pr.mergeableState ? `not mergeable (${pr.mergeableState})` : "not mergeable";
  if (pr.mergeableState) return pr.mergeableState;
  return null;
}

export function PRPanel({ session }: { session: Session }) {
  const conn = useRootStore((s) => s.getActiveConnection());
  const [pr, setPr] = useState<PullRequestPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [landing, setLanding] = useState(false);
  const [landError, setLandError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!conn) return;
    setLoading(true);
    setError(null);
    getPR(conn, session.slug)
      .then((d) => setPr(d))
      .catch((e: unknown) => {
        setPr(null);
        setError(e instanceof Error ? e.message : "Failed to load PR");
      })
      .finally(() => setLoading(false));
  }, [conn, session.slug]);

  useEffect(() => {
    load();
  }, [load]);

  const handleLand = useCallback(async () => {
    if (!conn) return;
    setLanding(true);
    setLandError(null);
    try {
      await postCommand(conn, {
        kind: "land",
        sessionSlug: session.slug,
        strategy: "squash",
      });
      load();
    } catch (e: unknown) {
      setLandError(e instanceof Error ? e.message : "Land failed");
    } finally {
      setLanding(false);
    }
  }, [conn, session.slug, load]);

  if (loading && !pr) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );
  }

  if (error && !pr) {
    return (
      <div className="p-4 space-y-3">
        <p className="text-sm text-fg-subtle">{error}</p>
        <button type="button" className="btn text-xs" onClick={load}>
          Retry
        </button>
      </div>
    );
  }

  if (!pr) {
    return <div className="p-4 text-sm text-fg-subtle">No pull request linked to this session.</div>;
  }

  const pillLabel = statePillLabel(pr);
  const review = reviewLabel(pr.reviewDecision);
  const merge = mergeLabel(pr);
  const failedCount = pr.checks.filter((c) => c.status === "completed" && (c.conclusion === "failure" || c.conclusion === "timed_out")).length;
  const canLand = session.status === "completed" && pr.state === "open" && failedCount === 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="card p-3 space-y-2">
          <div className="flex items-start gap-2">
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-fg hover:text-accent font-medium leading-snug flex-1 min-w-0 break-words"
            >
              <span className="text-fg-subtle font-mono mr-1">#{pr.number}</span>
              {pr.title}
            </a>
            <span className={cx("pill flex-shrink-0", STATE_PILL[pillLabel])}>{pillLabel}</span>
          </div>
          <div className="text-xs text-fg-subtle font-mono break-all">
            {pr.base} <span className="text-fg-subtle">←</span> {pr.head}
          </div>
          {(review || merge) && (
            <div className="text-xs text-fg-muted flex flex-wrap gap-x-3 gap-y-1">
              {merge && <span>{merge}</span>}
              {review && <span>{review}</span>}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="text-xs text-fg-subtle uppercase tracking-wide px-1">
            Checks {pr.checks.length > 0 && <span className="text-fg-subtle">({pr.checks.length})</span>}
          </div>
          {pr.checks.length === 0 && (
            <p className="text-sm text-fg-subtle px-1">No checks reported.</p>
          )}
          {pr.checks.map((check, idx) => {
            const failed = check.status === "completed" && (check.conclusion === "failure" || check.conclusion === "timed_out");
            const duration = formatDuration(check);
            return (
              <div key={`${check.name}-${idx}`} className="card p-2.5 flex items-center gap-2.5 text-xs">
                <CheckStatusIcon check={check} />
                <span className="text-fg flex-1 min-w-0 truncate">{check.name}</span>
                {duration && <span className="text-fg-subtle font-mono">{duration}</span>}
                {failed && check.url && (
                  <a
                    href={check.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-err hover:underline"
                  >
                    View logs
                  </a>
                )}
              </div>
            );
          })}
        </div>

        {landError && (
          <div className="text-xs text-err px-1">{landError}</div>
        )}
      </div>

      <div className="border-t border-border p-3 flex items-center gap-2 flex-wrap">
        <button type="button" className="btn text-xs" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        <a href={pr.url} target="_blank" rel="noreferrer" className="btn text-xs">
          Open in GitHub
        </a>
        {canLand && (
          <button
            type="button"
            className="btn-primary text-xs ml-auto"
            onClick={handleLand}
            disabled={landing}
          >
            {landing ? "Landing…" : "Land"}
          </button>
        )}
      </div>
    </div>
  );
}
