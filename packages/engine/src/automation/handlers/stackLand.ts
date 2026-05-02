import type { AutomationJob, DAGNode } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import type { DagRepo } from "../../dag/model.js";
import type { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import type { JobHandler } from "../types.js";

const POLL_DELAY_MS = 60_000;
const STACK_LAND_MAX_ATTEMPTS = 5;

function readStackLandAttempts(node: DAGNode): number {
  const raw = node.metadata?.["stackLandAttempts"];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

interface StackLandPayload {
  dagId: string;
}

export interface StackLandHandlerDeps {
  automationRepo: AutomationJobRepo;
  dagRepo: DagRepo;
  now?: () => Date;
}

export function enqueueStackLand(
  repo: AutomationJobRepo,
  dagId: string,
  delayMs = 0,
  now: () => Date = () => new Date(),
): AutomationJob {
  const runAt = new Date(now().getTime() + Math.max(0, delayMs)).toISOString();
  return repo.enqueue({
    kind: "stack-land",
    targetKind: "dag",
    targetId: dagId,
    payload: { dagId },
    runAt,
  });
}

function topoSort(nodes: DAGNode[]): DAGNode[] {
  const inDeg = new Map<string, number>();
  for (const n of nodes) inDeg.set(n.id, n.dependsOn.length);

  const queue: DAGNode[] = nodes.filter((n) => (inDeg.get(n.id) ?? 0) === 0);
  const out: DAGNode[] = [];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    out.push(next);
    seen.add(next.id);
    for (const m of nodes) {
      if (seen.has(m.id)) continue;
      if (!m.dependsOn.includes(next.id)) continue;
      const newDeg = (inDeg.get(m.id) ?? 0) - 1;
      inDeg.set(m.id, newDeg);
      if (newDeg === 0) queue.push(m);
    }
  }

  for (const n of nodes) {
    if (!seen.has(n.id)) out.push(n);
  }
  return out;
}

export function createStackLandHandler(deps: StackLandHandlerDeps): JobHandler {
  const now = deps.now ?? (() => new Date());
  return async (job: AutomationJob, ctx: EngineContext): Promise<void> => {
    const payload = job.payload as Partial<StackLandPayload>;
    const dagId = payload.dagId;
    if (typeof dagId !== "string" || dagId.length === 0) return;

    const dag = deps.dagRepo.get(dagId);
    if (!dag) return;
    if (dag.status !== "active" && dag.status !== "completed") return;

    const sorted = topoSort(dag.nodes);
    let anyStuck = false;

    for (const node of sorted) {
      if (node.status === "merged") continue;

      const attempts = readStackLandAttempts(node);
      if (attempts >= STACK_LAND_MAX_ATTEMPTS) {
        anyStuck = true;
        continue;
      }

      if (node.status !== "pr-open") {
        enqueueStackLand(deps.automationRepo, dagId, POLL_DELAY_MS, now);
        return;
      }

      const session = node.sessionSlug ? ctx.sessions.get(node.sessionSlug) : null;
      const pr = session?.pr;

      if (!session || !pr) {
        deps.dagRepo.updateNode(node.id, { status: "merged" });
        ctx.audit.record(
          "system",
          "dag.stack-land.skipped",
          { kind: "dag", id: dagId },
          { nodeId: node.id, sessionSlug: node.sessionSlug ?? null, reason: "no-pr" },
        );
        continue;
      }

      if (pr.state === "merged") {
        deps.dagRepo.updateNode(node.id, { status: "merged" });
        continue;
      }

      const ready =
        pr.state === "open" &&
        session.attention.some((a) => a.kind === "ci_passed") &&
        !session.attention.some((a) => a.kind === "ci_failed" || a.kind === "ci_pending");

      if (!ready || !node.sessionSlug) {
        enqueueStackLand(deps.automationRepo, dagId, POLL_DELAY_MS, now);
        return;
      }

      try {
        // force=true: the handler has already validated open PR + ci_passed + no
        // ci_failed/ci_pending, which is the safety bar for an unattended stack
        // land. Re-running readiness inside land() additionally requires "review",
        // and unattended ship sessions have no human reviewer — that gate
        // permanently blocks the merge.
        await ctx.landing.land(node.sessionSlug, "squash", true);
      } catch (err) {
        const nextAttempts = attempts + 1;
        const errorMessage = err instanceof Error ? err.message : String(err);
        deps.dagRepo.updateNode(node.id, {
          metadata: { ...node.metadata, stackLandAttempts: nextAttempts },
        });
        ctx.audit.record(
          "system",
          "dag.stack-land.merge-failed",
          { kind: "dag", id: dagId },
          {
            nodeId: node.id,
            sessionSlug: node.sessionSlug,
            attempt: nextAttempts,
            error: errorMessage,
          },
        );
        if (nextAttempts >= STACK_LAND_MAX_ATTEMPTS) {
          const parentSlug = dag.rootSessionSlug;
          if (parentSlug && ctx.sessions.get(parentSlug)) {
            ctx.sessions.appendAttention(parentSlug, {
              kind: "manual_intervention",
              message: `stack-land for node ${node.id} (${node.sessionSlug}) failed after ${nextAttempts} attempts: ${errorMessage}`,
              raisedAt: now().toISOString(),
            });
          }
          ctx.audit.record(
            "system",
            "dag.stack-land.escalated",
            { kind: "dag", id: dagId },
            {
              nodeId: node.id,
              sessionSlug: node.sessionSlug,
              attempts: nextAttempts,
              error: errorMessage,
            },
          );
          anyStuck = true;
          continue;
        }
        enqueueStackLand(deps.automationRepo, dagId, POLL_DELAY_MS, now);
        return;
      }

      deps.dagRepo.updateNode(node.id, { status: "merged" });
      ctx.audit.record(
        "system",
        "dag.stack-land.merged",
        { kind: "dag", id: dagId },
        { nodeId: node.id, sessionSlug: node.sessionSlug },
      );
    }

    if (anyStuck) {
      ctx.audit.record(
        "system",
        "dag.stack-land.complete-with-stuck",
        { kind: "dag", id: dagId },
        { nodeCount: dag.nodes.length },
      );
      return;
    }

    ctx.audit.record(
      "system",
      "dag.stack-land.complete",
      { kind: "dag", id: dagId },
      { nodeCount: dag.nodes.length },
    );
  };
}
