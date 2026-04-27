import type { TranscriptEvent } from "./transcript.js";

export type SessionStatus =
  | "pending"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled";

export type SessionMode =
  | "task"
  | "dag-task"
  | "plan"
  | "think"
  | "review"
  | "ship"
  | "rebase-resolver"
  | "loop";

export type ShipStage = "think" | "plan" | "dag" | "verify" | "done";

export interface QuickAction {
  id: string;
  label: string;
  command: string;
  args?: Record<string, unknown>;
}

export interface AttentionFlag {
  kind: "needs_input" | "ci_failed" | "rebase_conflict" | "quota_exhausted" | "judge_review" | "manual_intervention";
  message: string;
  raisedAt: string;
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

export interface PRSummary {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  base: string;
  head: string;
  title: string;
}

export interface Session {
  slug: string;
  title: string;
  prompt: string;
  mode: SessionMode;
  status: SessionStatus;
  shipStage?: ShipStage;
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
}

export interface SessionWithTranscript extends Session {
  transcript: TranscriptEvent[];
}

export interface CreateSessionRequest {
  prompt: string;
  mode?: SessionMode;
  title?: string;
  repoId?: string;
  baseBranch?: string;
  parentSlug?: string;
  modelHint?: string;
  attachments?: { name: string; mimeType: string; dataBase64: string }[];
  metadata?: Record<string, unknown>;
}

export interface CreateVariantsRequest {
  prompt: string;
  count: number;
  repoId?: string;
  baseBranch?: string;
  modelHint?: string;
  judgeRubric?: string;
}
