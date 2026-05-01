export type DoctorCheckStatus = "ok" | "degraded" | "error";

export type DoctorCheckName =
  | "provider-auth"
  | "github-auth"
  | "repo-state"
  | "worktree-health"
  | "dependency-cache"
  | "mcp-availability"
  | "push-config"
  | "sidecar-status";

export interface DoctorCheck {
  name: DoctorCheckName;
  status: DoctorCheckStatus;
  detail?: string;
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
