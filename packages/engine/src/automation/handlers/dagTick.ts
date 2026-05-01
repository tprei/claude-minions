import type { AutomationJob } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import type { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import type { JobHandler } from "../types.js";

interface DagTickPayload {
  dagId: string;
}

export interface DagTickHandlerDeps {
  now?: () => Date;
}

export function enqueueDagTick(
  repo: AutomationJobRepo,
  dagId: string,
  delayMs = 0,
  now: () => Date = () => new Date(),
): AutomationJob {
  const runAt = new Date(now().getTime() + Math.max(0, delayMs)).toISOString();
  return repo.enqueue({
    kind: "dag-tick",
    targetKind: "dag",
    targetId: dagId,
    payload: { dagId },
    runAt,
  });
}

export function createDagTickHandler(_deps: DagTickHandlerDeps = {}): JobHandler {
  return async (job: AutomationJob, ctx: EngineContext): Promise<void> => {
    const payload = job.payload as Partial<DagTickPayload>;
    const dagId = payload.dagId;
    if (typeof dagId !== "string" || dagId.length === 0) return;
    await ctx.dags.tick(dagId);
  };
}
