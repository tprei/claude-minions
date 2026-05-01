export type AutomationJobStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "expired";

export interface AutomationJob {
  id: string;
  kind: string;
  targetKind?: string;
  targetId?: string;
  payload: Record<string, unknown>;
  status: AutomationJobStatus;
  attempts: number;
  maxAttempts: number;
  nextRunAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}
