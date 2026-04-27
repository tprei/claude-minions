export type QualityCheckStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface QualityCheck {
  id: string;
  name: string;
  command: string;
  status: QualityCheckStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface QualityReport {
  sessionSlug: string;
  status: "passed" | "failed" | "partial" | "pending";
  checks: QualityCheck[];
  createdAt: string;
}

export interface QualityGateConfig {
  name: string;
  command: string;
  cwdRel?: string;
  timeoutMs?: number;
  required?: boolean;
}
