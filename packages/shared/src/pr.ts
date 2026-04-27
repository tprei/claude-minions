export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "stale"
  | "pending";

export interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: CheckConclusion;
  url?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PullRequestPreview {
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  base: string;
  head: string;
  mergeable?: boolean;
  mergeableState?: string;
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checks: CheckRun[];
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  updatedAt: string;
}
