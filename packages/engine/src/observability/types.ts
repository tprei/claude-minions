export type Level = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  t: string;
  lvl: Level;
  msg: string;
  [k: string]: unknown;
}

export type ObservabilityKind =
  | "engine-lifecycle"
  | "recovery-action"
  | "service-attached"
  | "http-request"
  | "sink-degraded"
  | "merge-inconsistent"
  | "push-send-failed"
  | "alert-send-failed"
  | "supervisor-error"
  | "ci-attempt-cap"
  | "alert"
  | "audit";
