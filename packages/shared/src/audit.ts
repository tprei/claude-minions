export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  target?: { kind: string; id: string };
  detail?: Record<string, unknown>;
}
