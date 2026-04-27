export type MemoryKind = "user" | "feedback" | "project" | "reference";
export type MemoryStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "superseded"
  | "pending_deletion";

export interface Memory {
  id: string;
  kind: MemoryKind;
  status: MemoryStatus;
  scope: "global" | "repo";
  repoId?: string;
  pinned: boolean;
  title: string;
  body: string;
  proposedBy?: string;
  proposedFromSession?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  supersedes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMemoryRequest {
  kind: MemoryKind;
  scope: "global" | "repo";
  repoId?: string;
  title: string;
  body: string;
  pinned?: boolean;
  proposedFromSession?: string;
}

export interface MemoryReviewCommand {
  decision: "approve" | "reject" | "delete" | "supersede";
  reason?: string;
  supersedesId?: string;
}
