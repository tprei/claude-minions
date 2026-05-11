// Fires when a task hit the CI attempt cap and is still in pr-open state.
// Two-phase: kind:"ci-attempt-cap" records the task; scan checks if still stuck.
import type { AnomalyRule, AnomalyRuleContext } from "./index.js";
import type { LogRecord } from "../../observability/types.js";

export const ciExhaustedRule: AnomalyRule = {
  id: "ci-exhausted",
  onLogRecord(record: LogRecord, ctx: AnomalyRuleContext): void {
    if (record["kind"] !== "ci-attempt-cap") return;
    const wfId = typeof record["workflowId"] === "string" ? record["workflowId"] : undefined;
    const taskId = typeof record["taskId"] === "string" ? record["taskId"] : undefined;
    if (!wfId || !taskId) return;
    const key = `${wfId}:${taskId}`;
    if (!ctx.state.pendingCiExhaustion.has(key)) {
      ctx.state.pendingCiExhaustion.set(key, { since: ctx.now(), alerted: false });
    }
  },
  async onScan(ctx: AnomalyRuleContext): Promise<void> {
    for (const [key, entry] of ctx.state.pendingCiExhaustion) {
      if (entry.alerted) continue;
      const colonIdx = key.indexOf(":");
      if (colonIdx === -1) {
        ctx.state.pendingCiExhaustion.delete(key);
        continue;
      }
      const wfId = key.slice(0, colonIdx);
      const taskId = key.slice(colonIdx + 1);
      if (!wfId || !taskId) {
        ctx.state.pendingCiExhaustion.delete(key);
        continue;
      }
      const wf = await ctx.workflowRepo.get(wfId);
      if (!wf) {
        ctx.state.pendingCiExhaustion.delete(key);
        continue;
      }
      const task = wf.graph[taskId];
      if (!task) {
        ctx.state.pendingCiExhaustion.delete(key);
        continue;
      }
      if (task.executionStatus === "pr-open") {
        entry.alerted = true;
        ctx.fireAlert({
          kind: "ci-exhausted",
          severity: "error",
          message: `CI attempt cap reached and task ${taskId} is still in pr-open`,
          workflowId: wfId,
          taskId,
          detail: { since: new Date(entry.since).toISOString() },
        });
      } else {
        ctx.state.pendingCiExhaustion.delete(key);
      }
    }
  },
};
