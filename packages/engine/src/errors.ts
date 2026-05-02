export type EngineErrorCode =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "unauthorized"
  | "forbidden"
  | "internal"
  | "upstream"
  | "transient_push_error"
  | "unsupported";

const codeToStatus: Record<EngineErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  unauthorized: 401,
  forbidden: 403,
  internal: 500,
  upstream: 502,
  transient_push_error: 503,
  unsupported: 501,
};

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly detail?: Record<string, unknown>;
  readonly status: number;

  constructor(code: EngineErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.detail = detail;
    this.status = codeToStatus[code];
  }

  toJSON(): Record<string, unknown> {
    return { error: this.code, message: this.message, detail: this.detail };
  }
}

export function isEngineError(e: unknown): e is EngineError {
  return e instanceof EngineError;
}
