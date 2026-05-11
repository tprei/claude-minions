import { randomUUID } from "node:crypto";
import type { LogRecord } from "../observability/types.js";
import type { AuditRepo } from "./audit-repo.js";
import type { AuditEvent } from "./alert.js";

const AUDIT_KINDS = new Set<string>([
  "engine-lifecycle",
  "recovery-action",
  "service-attached",
  "merge-inconsistent",
  "push-send-failed",
  "alert-send-failed",
  "supervisor-error",
  "ci-attempt-cap",
  "alert",
  "task-transitioned",
  "graph-operation-changed",
  "workflow-status-changed",
]);

const EXCLUDED_FIELDS = new Set(["t", "lvl", "msg", "kind", "workflowId", "taskId", "component", "service"]);

function extractDetailFields(record: LogRecord): Record<string, unknown> | undefined {
  const detail: Record<string, unknown> = {};
  let hasAny = false;
  for (const [k, v] of Object.entries(record)) {
    if (!EXCLUDED_FIELDS.has(k)) {
      detail[k] = v;
      hasAny = true;
    }
  }
  return hasAny ? detail : undefined;
}

export class AuditProjector {
  constructor(private readonly repo: AuditRepo) {}

  project(record: LogRecord): void {
    if (typeof record["kind"] !== "string" || !AUDIT_KINDS.has(record["kind"])) return;
    const event: AuditEvent = {
      id: randomUUID(),
      timestamp: record.t,
      actor: typeof record["component"] === "string" ? record["component"] : "engine",
      action: record["kind"] as string,
    };
    if (typeof record["workflowId"] === "string") event.workflowId = record["workflowId"];
    if (typeof record["taskId"] === "string") event.taskId = record["taskId"];
    const detail = extractDetailFields(record);
    if (detail !== undefined) event.detail = detail;
    this.repo.insert(event);
  }
}
