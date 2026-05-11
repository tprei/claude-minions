export interface QualityGateConfig {
  name: string;
  command: string;
  cwdRel?: string;
  timeoutMs?: number;
  required?: boolean;
}

export interface QualityCheckResult {
  id: string;
  name: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
}

export type QualityRunStatus = "passed" | "failed" | "partial";

export interface QualityRunResult {
  status: QualityRunStatus;
  checks: QualityCheckResult[];
}

export interface QualityPlugin {
  loadConfig(workspacePath: string): Promise<QualityGateConfig[]>;
  run(
    configs: QualityGateConfig[],
    workspacePath: string,
    opts: { signal?: AbortSignal; defaultTimeoutMs?: number },
  ): Promise<QualityRunResult>;
}
