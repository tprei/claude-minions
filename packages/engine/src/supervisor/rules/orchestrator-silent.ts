// Fires when a workflow has a running task but no log events for 30 minutes.
// Depends on ObservabilityService feeding workflow events into the log pipeline.
// onLogRecord populates activity; onScan checks for silence.
import type { AnomalyRule, AnomalyRuleContext } from "./index.js";
import type { LogRecord } from "../../observability/types.js";

const SILENCE_MS = 30 * 60 * 1000;

const TERMINAL_EXECUTION_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "merged",
  "pr-open",
  "needs-review",
]);

export const orchestratorSilentRule: AnomalyRule = {
  id: "orchestrator-silent",
  onLogRecord(record: LogRecord, ctx: AnomalyRuleContext): void {
    if (typeof record["workflowId"] !== "string") return;
    if (record["kind"] !== "task-transitioned" && record["kind"] !== "run-started") return;
    const workflowId = record["workflowId"];
    const existing = ctx.state.activity.get(workflowId) ?? {
      hasRunningTask: false,
      lastEventAt: 0,
      lastAlertAt: 0,
    };
    existing.lastEventAt = ctx.now();
    if (record["kind"] === "run-started") {
      existing.hasRunningTask = true;
    }
    if (record["kind"] === "task-transitioned") {
      const to = record["toExecutionStatus"];
      if (typeof to === "string" && TERMINAL_EXECUTION_STATUSES.has(to)) {
        existing.hasRunningTask = false;
      }
    }
    ctx.state.activity.set(workflowId, existing);
  },
  async onScan(ctx: AnomalyRuleContext): Promise<void> {
    const now = ctx.now();
    for (const [workflowId, activity] of ctx.state.activity) {
      if (!activity.hasRunningTask) continue;
      if (now - activity.lastEventAt < SILENCE_MS) continue;
      if (now - activity.lastAlertAt < SILENCE_MS) continue;
      activity.lastAlertAt = now;
      ctx.fireAlert({
        kind: "orchestrator-silent",
        severity: "warn",
        message: `Orchestrator silent for workflow ${workflowId}: no events in 30 minutes`,
        workflowId,
        detail: { lastEventAt: new Date(activity.lastEventAt).toISOString() },
      });
    }
  },
};
