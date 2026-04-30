import type { EngineContext } from "../context.js";
import { nowIso } from "../util/time.js";

export function maybeApplyBudgetCap(
  ctx: EngineContext,
  slug: string,
  costUsd: number,
): void {
  const session = ctx.sessions.get(slug);
  if (!session) return;
  const cap = session.costBudgetUsd;
  if (cap === undefined || cap === null) return;
  if (costUsd < cap) return;
  if (session.attention.some((a) => a.kind === "budget_exceeded")) return;

  ctx.sessions.markWaitingInput(slug, "budget exceeded");
  ctx.sessions.appendAttention(slug, {
    kind: "budget_exceeded",
    message: `cost $${costUsd.toFixed(4)} exceeded cap $${cap}`,
    raisedAt: nowIso(),
  });
  ctx.audit.record(
    "engine",
    "session.budget.exceeded",
    { kind: "session", id: slug },
    { costUsd, costBudgetUsd: cap },
  );
}
