import type { TaskExecutionStatus } from "@minions/engine-next";

export interface StatusVisual {
  dotClass: string;
  label: string;
}

/**
 * Maps a TaskExecutionStatus to a consistent color + label for UI rendering.
 * Colors are chosen to match the visual meaning of the old Session status
 * indicator and to communicate the new lifecycle stages clearly.
 */
export const STATUS_DOT: Record<TaskExecutionStatus, string> = {
  pending: "bg-zinc-500",
  ready: "bg-blue-400 animate-pulse",
  running: "bg-green-400 animate-pulse",
  finalizing: "bg-teal-400 animate-pulse",
  "quality-pending": "bg-amber-400 animate-pulse",
  "ci-pending": "bg-amber-400",
  "pr-open": "bg-indigo-400",
  merged: "bg-purple-400",
  "needs-review": "bg-amber-400 animate-pulse",
  completed: "bg-blue-400",
  failed: "bg-red-500",
  cancelled: "bg-zinc-600",
};

export const STATUS_LABEL: Record<TaskExecutionStatus, string> = {
  pending: "pending",
  ready: "ready",
  running: "running",
  finalizing: "finalizing",
  "quality-pending": "quality check",
  "ci-pending": "CI pending",
  "pr-open": "PR open",
  merged: "merged",
  "needs-review": "needs review",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

export function statusToVisual(status: TaskExecutionStatus): StatusVisual {
  return {
    dotClass: STATUS_DOT[status],
    label: STATUS_LABEL[status],
  };
}

/**
 * Whether a task is in an "active" state (occupying an agent slot or
 * waiting on gating condition). Used for filter chips.
 */
export function isRunning(status: TaskExecutionStatus): boolean {
  return status === "running" || status === "ready" || status === "finalizing";
}

export function isWaiting(status: TaskExecutionStatus): boolean {
  return status === "quality-pending" || status === "ci-pending" || status === "needs-review";
}

export function isTerminal(status: TaskExecutionStatus): boolean {
  return status === "completed" || status === "pr-open" || status === "merged"
    || status === "failed" || status === "cancelled";
}

export function isCompleted(status: TaskExecutionStatus): boolean {
  return status === "completed" || status === "pr-open" || status === "merged";
}

export function isFailed(status: TaskExecutionStatus): boolean {
  return status === "failed";
}
