export type LifecycleEventType =
  | "engine.started"
  | "engine.crashed"
  | "ci.exhausted"
  | "resource.alert";

export type LifecycleSeverity = "info" | "warn" | "error";

export interface LifecycleEvent {
  id: string;
  timestamp: string;
  eventType: LifecycleEventType;
  severity: LifecycleSeverity;
  message: string;
  detail?: Record<string, unknown>;
}
