import type { AutomationJob } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import type { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import type { JobHandler } from "../types.js";

const POLL_INTERVAL_MS = 30_000;

interface CiPollPayload {
  sessionSlug: string;
}

export interface CiPollHandlerDeps {
  repo: AutomationJobRepo;
  now?: () => Date;
}

export function enqueueCiPoll(
  repo: AutomationJobRepo,
  sessionSlug: string,
  delayMs: number = POLL_INTERVAL_MS,
  now: () => Date = () => new Date(),
): AutomationJob {
  const runAt = new Date(now().getTime() + Math.max(0, delayMs)).toISOString();
  return repo.enqueue({
    kind: "ci-poll",
    targetKind: "session",
    targetId: sessionSlug,
    payload: { sessionSlug },
    runAt,
  });
}

export function createCiPollHandler(deps: CiPollHandlerDeps): JobHandler {
  const now = deps.now ?? (() => new Date());
  return async (job: AutomationJob, ctx: EngineContext): Promise<void> => {
    const payload = job.payload as Partial<CiPollPayload>;
    const slug = payload.sessionSlug;
    if (typeof slug !== "string" || slug.length === 0) return;

    const session = ctx.sessions.get(slug);
    if (!session || !session.pr) return;
    if (session.pr.state !== "open") return;
    if (session.status === "failed" || session.status === "cancelled") return;

    // Exhausted self-heal sessions still keep polling. A late-arriving fix
    // commit (manual push, slow CI run that finally passes, or a different
    // child session pushing to the same branch) should still flip the PR
    // to ready. The session's selfHealCi metadata is already false at this
    // point, so ctx.ci.poll falls through to the non-self-heal branch.

    await ctx.ci.poll(slug);

    const refreshed = ctx.sessions.get(slug);
    if (!refreshed || !refreshed.pr) return;
    if (refreshed.pr.state !== "open") return;
    if (refreshed.status === "failed" || refreshed.status === "cancelled") return;

    enqueueCiPoll(deps.repo, slug, POLL_INTERVAL_MS, now);
  };
}
