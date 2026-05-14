import type { TaskExecutionStatus, TaskStackStatus } from "@minions/engine";

export interface StatusVisual {
  dotClass: string;
  label: string;
  badgeLabel?: string;
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

const STACK_BADGE: Record<TaskStackStatus, string | undefined> = {
  clean: undefined,
  "restack-pending": "RESTACK PENDING",
  restacking: "RESTACKING",
  "restack-conflict": "CONFLICT",
  "stale-artifacts": "STALE",
};

export function getTaskVisual(
  executionStatus: TaskExecutionStatus,
  stackStatus: TaskStackStatus,
): StatusVisual {
  const badgeLabel = STACK_BADGE[stackStatus];
  return {
    dotClass: STATUS_DOT[executionStatus],
    label: STATUS_LABEL[executionStatus],
    ...(badgeLabel !== undefined ? { badgeLabel } : {}),
  };
}

export function statusToVisual(status: TaskExecutionStatus): StatusVisual {
  return {
    dotClass: STATUS_DOT[status],
    label: STATUS_LABEL[status],
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled task status: ${String(value)}`);
}

export function isRunning(status: TaskExecutionStatus): boolean {
  switch (status) {
    case "ready":
    case "running":
    case "finalizing":
      return true;
    case "pending":
    case "completed":
    case "quality-pending":
    case "ci-pending":
    case "pr-open":
    case "merged":
    case "failed":
    case "cancelled":
    case "needs-review":
      return false;
    default:
      return assertNever(status);
  }
}

export function isWaiting(status: TaskExecutionStatus): boolean {
  switch (status) {
    case "quality-pending":
    case "ci-pending":
    case "needs-review":
      return true;
    case "pending":
    case "ready":
    case "running":
    case "completed":
    case "finalizing":
    case "pr-open":
    case "merged":
    case "failed":
    case "cancelled":
      return false;
    default:
      return assertNever(status);
  }
}

export function isTerminal(status: TaskExecutionStatus): boolean {
  switch (status) {
    case "completed":
    case "pr-open":
    case "merged":
    case "failed":
    case "cancelled":
      return true;
    case "pending":
    case "ready":
    case "running":
    case "finalizing":
    case "quality-pending":
    case "ci-pending":
    case "needs-review":
      return false;
    default:
      return assertNever(status);
  }
}

export function isCompleted(status: TaskExecutionStatus): boolean {
  switch (status) {
    case "completed":
    case "pr-open":
    case "merged":
      return true;
    case "pending":
    case "ready":
    case "running":
    case "finalizing":
    case "quality-pending":
    case "ci-pending":
    case "failed":
    case "cancelled":
    case "needs-review":
      return false;
    default:
      return assertNever(status);
  }
}

export function isFailed(status: TaskExecutionStatus): boolean {
  switch (status) {
    case "failed":
      return true;
    case "pending":
    case "ready":
    case "running":
    case "completed":
    case "finalizing":
    case "quality-pending":
    case "ci-pending":
    case "pr-open":
    case "merged":
    case "cancelled":
    case "needs-review":
      return false;
    default:
      return assertNever(status);
  }
}
