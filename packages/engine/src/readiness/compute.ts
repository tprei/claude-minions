import type { Session, QualityReport, ReadinessCheck, ReadinessStatus } from "@minions/shared";

export function computePrCheck(session: Session): ReadinessCheck {
  if (!session.pr) {
    return { id: "pr", label: "PR exists", status: "blocked", detail: "No pull request found" };
  }
  if (session.pr.state !== "open") {
    return { id: "pr", label: "PR open", status: "blocked", detail: `PR is ${session.pr.state}` };
  }
  if (session.pr.draft) {
    return { id: "pr", label: "PR not draft", status: "warn", detail: "PR is a draft" };
  }
  return { id: "pr", label: "PR open", status: "ok" };
}

export function computeReviewCheck(session: Session): ReadinessCheck {
  if (!session.pr) {
    return { id: "review", label: "Review decision", status: "pending" };
  }
  const rd = (session.pr as { reviewDecision?: string | null }).reviewDecision;
  if (rd === "APPROVED") {
    return { id: "review", label: "Review approved", status: "ok" };
  }
  if (rd === "CHANGES_REQUESTED") {
    return { id: "review", label: "Review", status: "blocked", detail: "Changes requested" };
  }
  return { id: "review", label: "Review", status: "pending", detail: "Awaiting review" };
}

export function computeQualityCheck(report: QualityReport | null): ReadinessCheck {
  if (!report) {
    return { id: "quality", label: "Quality checks", status: "pending", detail: "No report yet" };
  }
  if (report.status === "passed") {
    return { id: "quality", label: "Quality checks passed", status: "ok" };
  }
  if (report.status === "partial") {
    return { id: "quality", label: "Quality checks", status: "warn", detail: "Some checks failed (non-required)" };
  }
  if (report.status === "failed") {
    return { id: "quality", label: "Quality checks", status: "blocked", detail: "Required checks failed" };
  }
  return { id: "quality", label: "Quality checks", status: "pending" };
}

export function computeCiCheck(session: Session): ReadinessCheck {
  if (!session.pr) {
    return { id: "ci", label: "CI checks", status: "pending" };
  }
  const hasFailed = session.attention.some((a) => a.kind === "ci_failed");
  if (hasFailed) {
    return { id: "ci", label: "CI checks", status: "blocked", detail: "CI checks failed" };
  }
  return { id: "ci", label: "CI checks", status: "ok" };
}

export function computeConflictCheck(session: Session): ReadinessCheck {
  const hasConflict = session.attention.some((a) => a.kind === "rebase_conflict");
  if (hasConflict) {
    return { id: "conflict", label: "No rebase conflict", status: "blocked", detail: "Rebase conflict on session" };
  }
  return { id: "conflict", label: "No rebase conflict", status: "ok" };
}

export function computeOverallStatus(checks: ReadinessCheck[]): ReadinessStatus {
  if (checks.some((c) => c.status === "blocked")) return "blocked";
  if (checks.some((c) => c.status === "pending" || c.status === "unknown")) return "pending";
  if (checks.every((c) => c.status === "ok" || c.status === "warn")) return "ready";
  return "unknown";
}
