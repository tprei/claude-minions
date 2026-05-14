export type DoctorCheckStatus = "ok" | "degraded" | "error";

export type DoctorCheckName =
  | "sqlite-wal"
  | "sqlite-busy-timeout"
  | "repo-state"
  | "worktree-health"
  | "tmux-runtime"
  | "github-auth"
  | "disk-free"
  | "dependency-cache"
  | "push-config";

export interface DoctorCheck {
  name: DoctorCheckName;
  status: DoctorCheckStatus;
  detail?: string;
  checkedAt: string;
}

export interface DoctorReport {
  status: DoctorCheckStatus;
  checks: DoctorCheck[];
  checkedAt: string;
}

export type AlertKind =
  | "stalled-pending"
  | "human-input-stuck"
  | "automation-exhausted"
  | "disk-pressure"
  | "github-auth"
  | "provider-auth"
  | "repeated-ci-fail";

export type AlertSeverity = "info" | "warn" | "error";

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  count?: number;
  detail?: string;
}
