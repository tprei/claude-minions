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

export const MEMORY_BODY_MAX_LEN = 2048;

export type MemoryValidationCode = "memory_body_too_long";

export class MemoryValidationError extends Error {
  readonly code: MemoryValidationCode;
  constructor(code: MemoryValidationCode, message: string) {
    super(message);
    this.name = "MemoryValidationError";
    this.code = code;
  }
}

export function validateMemoryBody(body: string): void {
  if (body.length > MEMORY_BODY_MAX_LEN) {
    throw new MemoryValidationError(
      "memory_body_too_long",
      `body exceeds ${MEMORY_BODY_MAX_LEN} characters (got ${body.length})`,
    );
  }
}
