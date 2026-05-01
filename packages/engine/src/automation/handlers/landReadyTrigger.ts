import type { AutomationJob } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import type { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import type { JobHandler } from "../types.js";

interface LandReadyPayload {
  sessionSlug: string;
}

export interface LandReadyHandlerDeps {
  automationRepo: AutomationJobRepo;
}

export function enqueueLandReady(
  repo: AutomationJobRepo,
  sessionSlug: string,
): AutomationJob | null {
  const existing = repo.findByTarget("session", sessionSlug);
  const inFlight = existing.some(
    (j) => j.kind === "land-ready" && (j.status === "pending" || j.status === "running"),
  );
  if (inFlight) return null;
  return repo.enqueue({
    kind: "land-ready",
    targetKind: "session",
    targetId: sessionSlug,
    payload: { sessionSlug },
  });
}

export function createLandReadyHandler(deps: LandReadyHandlerDeps): JobHandler {
  return async (job: AutomationJob, ctx: EngineContext): Promise<void> => {
    const payload = job.payload as Partial<LandReadyPayload>;
    const slug = payload.sessionSlug;
    if (typeof slug !== "string" || slug.length === 0) return;

    const flagEnabled = ctx.runtime.effective()["autoLandReadyOnGreen"] === true;
    if (!flagEnabled) return;

    const session = ctx.sessions.get(slug);
    if (!session) return;
    if (!session.pr || session.pr.state !== "open") return;

    let readiness: Awaited<ReturnType<typeof ctx.readiness.compute>>;
    try {
      readiness = await ctx.readiness.compute(slug);
    } catch (err) {
      ctx.log.warn("landReady: readiness check failed", {
        slug,
        err: (err as Error).message,
      });
      return;
    }

    if (readiness.status !== "ready") return;

    try {
      await ctx.landing.land(slug, "squash");
    } catch (err) {
      ctx.log.warn("landReady: land failed", {
        slug,
        err: (err as Error).message,
      });
    }
  };
}
