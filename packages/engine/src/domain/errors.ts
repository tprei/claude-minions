export type DomainErrorCode =
  | "invalid_workflow"
  | "invalid_transition"
  | "session_mismatch"
  | "not_found"
  | "version_conflict"
  | "idempotency_collision"
  | "invalid_plan"
  | "unstackable_dependencies";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}
