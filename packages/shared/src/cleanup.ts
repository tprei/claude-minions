import type { SessionStatus } from "./session.js";

export const CLEANUPABLE_STATUSES = ["completed", "failed", "cancelled"] as const;
export type CleanupableStatus = (typeof CLEANUPABLE_STATUSES)[number];

export const CLEANUP_DEFAULT_LIMIT = 100;
export const CLEANUP_MAX_LIMIT = 500;

export interface CleanupCandidate {
  slug: string;
  title: string;
  status: SessionStatus;
  completedAt: string | null;
  worktreePath: string | null;
  branch: string | null;
}

export interface CleanupCandidatesResponse {
  items: CleanupCandidate[];
  nextCursor: string | null;
}

export interface CleanupPreviewRequest {
  slugs: string[];
  removeWorktree: boolean;
}

export interface CleanupPreviewResponse {
  count: number;
  totalBytes: number;
  ineligible: { slug: string; reason: string }[];
}

export interface CleanupExecuteRequest {
  slugs: string[];
  removeWorktree: boolean;
}

export interface CleanupExecuteError {
  slug: string;
  code: "not_found" | "ineligible_status" | "worktree_remove_failed" | "internal";
  message: string;
}

export interface CleanupExecuteResponse {
  deleted: number;
  bytesReclaimed: number;
  errors: CleanupExecuteError[];
}
