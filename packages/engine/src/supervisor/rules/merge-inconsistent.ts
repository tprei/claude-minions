// Fires when a merge-task state transition fails after GitHub confirms the merge.
// Triggered by kind:"merge-inconsistent" log records from MergeService.
import type { AnomalyRule, AnomalyRuleContext } from "./index.js";
import type { LogRecord } from "../../observability/types.js";

export const mergeInconsistentRule: AnomalyRule = {
  id: "merge-inconsistent",
  onLogRecord(record: LogRecord, ctx: AnomalyRuleContext): void {
    if (record["kind"] !== "merge-inconsistent") return;
    const partial: Parameters<typeof ctx.fireAlert>[0] = {
      kind: "merge-inconsistent",
      severity: "error",
      message: "Merge state inconsistent: GitHub merged but internal transition failed",
      detail: {
        sha: record["sha"],
        error: record["error"],
      },
    };
    if (typeof record["workflowId"] === "string") partial.workflowId = record["workflowId"];
    if (typeof record["taskId"] === "string") partial.taskId = record["taskId"];
    ctx.fireAlert(partial);
  },
};
