import { DomainError } from "../domain/errors.js";

export interface HttpErrorResponse {
  status: number;
  body: { code: string; message: string; details: Record<string, unknown> };
}

export function domainErrorToHttp(error: DomainError): HttpErrorResponse {
  switch (error.code) {
    case "not_found":
      return { status: 404, body: { code: error.code, message: error.message, details: error.details } };
    case "invalid_workflow":
    case "invalid_transition":
    case "session_mismatch":
      return { status: 400, body: { code: error.code, message: error.message, details: error.details } };
    case "version_conflict":
    case "idempotency_collision":
      return { status: 409, body: { code: error.code, message: error.message, details: error.details } };
  }
}
