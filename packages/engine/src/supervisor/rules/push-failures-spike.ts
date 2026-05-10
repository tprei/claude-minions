// Fires when more than 5 push-send failures occur within a rolling 60-second window.
// Triggered by kind:"push-send-failed" log records from PushService.
import type { AnomalyRule, AnomalyRuleContext } from "./index.js";
import type { LogRecord } from "../../observability/types.js";

const WINDOW_MS = 60_000;
const THRESHOLD = 5;

export const pushFailuresSpikeRule: AnomalyRule = {
  id: "push-failures-spike",
  onLogRecord(record: LogRecord, ctx: AnomalyRuleContext): void {
    if (record["kind"] !== "push-send-failed") return;
    const now = ctx.now();
    const cutoff = now - WINDOW_MS;
    ctx.state.pushFailureWindow.push(now);
    ctx.state.pushFailureWindow = ctx.state.pushFailureWindow.filter((t) => t > cutoff);
    if (ctx.state.pushFailureWindow.length > THRESHOLD) {
      const count = ctx.state.pushFailureWindow.length;
      ctx.state.pushFailureWindow = [];
      ctx.fireAlert({
        kind: "push-failures-spike",
        severity: "warn",
        message: `Push notification failures spike: ${count} failures in 60s`,
        detail: { count },
      });
    }
  },
  onScan(ctx: AnomalyRuleContext): void {
    const cutoff = ctx.now() - WINDOW_MS;
    const w = ctx.state.pushFailureWindow;
    while (w.length > 0 && w[0]! < cutoff) w.shift();
  },
};
