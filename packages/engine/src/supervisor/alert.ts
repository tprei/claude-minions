export type AlertKind =
  | "merge-inconsistent"
  | "push-failures-spike"
  | "boot-recovery-failed"
  | "orchestrator-silent"
  | "ci-exhausted";

export type AlertSeverity = "warn" | "error";

export interface Alert {
  id: string;
  timestamp: string;
  kind: AlertKind;
  severity: AlertSeverity;
  message: string;
  workflowId?: string;
  taskId?: string;
  detail?: Record<string, unknown>;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  workflowId?: string;
  taskId?: string;
  targetKind?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}

export interface AlertSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
