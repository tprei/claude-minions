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
