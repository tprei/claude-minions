import type { TranscriptEvent } from "./transcript.js";

export const SESSION_STATUSES = [
  "pending",
  "running",
  "waiting_input",
  "completed",
  "failed",
  "cancelled",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_MODES = [
  "task",
  "dag-task",
  "plan",
  "think",
  "review",
  "ship",
  "rebase-resolver",
  "loop",
  "verify-child",
] as const;

export type SessionMode = (typeof SESSION_MODES)[number];

export type ShipStage = "think" | "plan" | "dag" | "verify" | "done";

export const PERMISSION_TIERS = ["read", "worktree", "full"] as const;
export type PermissionTier = (typeof PERMISSION_TIERS)[number];

export const SESSION_BUCKETS = [
  "bug-fix", "feature", "refactor", "dogfood-fix", "ci-fix",
  "ship", "dag-task", "think", "review", "rebase-resolver",
  "loop", "probe", "other",
] as const;
export type SessionBucket = (typeof SESSION_BUCKETS)[number];

export interface QuickAction {
  id: string;
  label: string;
  command: string;
  args?: Record<string, unknown>;
}

export interface AttentionFlag {
  kind: "needs_input" | "ci_failed" | "ci_pending" | "ci_passed" | "ci_self_heal_exhausted" | "rebase_conflict" | "quota_exhausted" | "judge_review" | "manual_intervention" | "budget_exceeded" | "verify_failed";
  message: string;
  raisedAt: string;
}

export interface AttentionInboxItem {
  sessionSlug: string;
  sessionTitle: string;
  mode: SessionMode;
  status: SessionStatus;
  attention: AttentionFlag;
}

export interface SessionStats {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  toolCalls: number;
}

export interface SessionRef {
  slug: string;
  parentSlug?: string;
  rootSlug?: string;
  childSlugs: string[];
}

export type PRReviewDecision = "approved" | "changes_requested" | "commented" | "review_required";

export interface PRSummary {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  base: string;
  head: string;
  title: string;
  reviewDecision?: PRReviewDecision | null;
}

export interface Session {
  slug: string;
  title: string;
  prompt: string;
  mode: SessionMode;
  status: SessionStatus;
  shipStage?: ShipStage;
  permissionTier?: PermissionTier;
  repoId?: string;
  branch?: string;
  baseBranch?: string;
  worktreePath?: string;
  parentSlug?: string;
  rootSlug?: string;
  childSlugs: string[];
  pr?: PRSummary;
  attention: AttentionFlag[];
  quickActions: QuickAction[];
  stats: SessionStats;
  provider: string;
  modelHint?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastTurnAt?: string;
  dagId?: string;
  dagNodeId?: string;
  loopId?: string;
  variantOf?: string;
  metadata: Record<string, unknown>;
  bucket?: SessionBucket;
  costBudgetUsd?: number;
}

export interface SessionWithTranscript extends Session {
  transcript: TranscriptEvent[];
}

export const ALLOWED_ATTACHMENT_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AllowedAttachmentMimeType = (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number];

export interface AttachmentInput {
  name: string;
  mimeType: string;
  dataBase64?: string;
  url?: string;
}

export interface CreateSessionRequest {
  prompt: string;
  mode?: SessionMode;
  title?: string;
  slug?: string;
  repoId?: string;
  baseBranch?: string;
  parentSlug?: string;
  modelHint?: string;
  attachments?: AttachmentInput[];
  metadata?: Record<string, unknown>;
  bucket?: SessionBucket;
  costBudgetUsd?: number;
}

export interface CreateVariantsRequest {
  prompt: string;
  /**
   * Total number of worker sessions to spawn (parent counts as 1).
   * count=1 runs the parent solo with no children; count>=2 runs the
   * parent plus (count-1) children. Clamped to [1, 10] by the engine.
   */
  count: number;
  repoId?: string;
  baseBranch?: string;
  modelHint?: string;
  judgeRubric?: string;
}

export interface CreateVariantsResponse {
  parentSlug: string;
  childSlugs: string[];
}
