export interface LoopDefinition {
  id: string;
  label: string;
  prompt: string;
  intervalSec: number;
  enabled: boolean;
  modelHint?: string;
  repoId?: string;
  baseBranch?: string;
  jitterPct?: number;
  maxConcurrent?: number;
  consecutiveFailures: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastSessionSlug?: string;
  createdAt: string;
  updatedAt: string;
}
