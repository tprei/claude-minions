// Fires once at boot if the boot recovery report contains any failures.
// Triggered by kind:"engine-lifecycle" with phase:"boot-complete".
import type { AnomalyRule, AnomalyRuleContext } from "./index.js";
import type { LogRecord } from "../../observability/types.js";

export const bootRecoveryFailedRule: AnomalyRule = {
  id: "boot-recovery-failed",
  onLogRecord(record: LogRecord, ctx: AnomalyRuleContext): void {
    if (record["kind"] !== "engine-lifecycle") return;
    if (record["phase"] !== "boot-complete") return;
    const report = record["report"];
    if (report === null || typeof report !== "object") return;
    const failures = (report as Record<string, unknown>)["failures"];
    if (!Array.isArray(failures) || failures.length === 0) return;
    ctx.fireAlert({
      kind: "boot-recovery-failed",
      severity: "error",
      message: `Boot recovery failed for ${failures.length} workflow(s)`,
      detail: { failures },
    });
  },
};
