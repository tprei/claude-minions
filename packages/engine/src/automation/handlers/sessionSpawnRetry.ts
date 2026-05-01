import type { AutomationJob } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import type { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import { nowIso } from "../../util/time.js";
import type { JobHandler } from "../types.js";

const RETRY_BASE_MS = 60_000;
const RETRY_INCREMENT_MS = 30_000;
const RETRY_MAX_DELAY_MS = 5 * 60_000;
export const SESSION_SPAWN_RETRY_MAX_ATTEMPTS = 20;

interface SessionSpawnRetryPayload {
  slug: string;
  attempts: number;
}

export interface SessionSpawnRetryHandlerDeps {
  repo: AutomationJobRepo;
  now?: () => Date;
}

function backoffMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS + attempts * RETRY_INCREMENT_MS, RETRY_MAX_DELAY_MS);
}

export function enqueueSessionSpawnRetry(
  repo: AutomationJobRepo,
  slug: string,
  attempts: number,
  delayMs = 0,
  now: () => Date = () => new Date(),
): AutomationJob {
  const runAt = new Date(now().getTime() + Math.max(0, delayMs)).toISOString();
  return repo.enqueue({
    kind: "session-spawn-retry",
    targetKind: "session",
    targetId: slug,
    payload: { slug, attempts },
    runAt,
    maxAttempts: SESSION_SPAWN_RETRY_MAX_ATTEMPTS + 5,
  });
}

export function createSessionSpawnRetryHandler(
  deps: SessionSpawnRetryHandlerDeps,
): JobHandler {
  const now = deps.now ?? (() => new Date());
  return async (job: AutomationJob, ctx: EngineContext): Promise<void> => {
    const payload = job.payload as Partial<SessionSpawnRetryPayload>;
    const slug = payload.slug;
    const attempts = typeof payload.attempts === "number" ? payload.attempts : 0;
    if (typeof slug !== "string" || slug.length === 0) return;

    const session = ctx.sessions.get(slug);
    if (!session) return;
    if (session.status !== "pending") return;

    const result = await ctx.sessions.spawnPending(slug);
    if (result.spawned) {
      ctx.audit.record(
        "system",
        "session.spawn-retry.spawned",
        { kind: "session", id: slug },
        { attempts },
      );
      return;
    }

    const reason = result.reason ?? "unknown";
    if (!reason.startsWith("resource:") && !reason.startsWith("non-interactive") &&
        !reason.startsWith("autonomous_loop") && !reason.startsWith("dag_task") &&
        !reason.startsWith("background")) {
      // Not a resource-pressure or class-cap denial — give up to avoid spinning.
      ctx.audit.record(
        "system",
        "session.spawn-retry.aborted",
        { kind: "session", id: slug },
        { attempts, reason },
      );
      return;
    }

    const nextAttempts = attempts + 1;
    if (nextAttempts >= SESSION_SPAWN_RETRY_MAX_ATTEMPTS) {
      ctx.sessions.appendAttention(slug, {
        kind: "manual_intervention",
        message: "admission exhausted (resource pressure); please retry or raise limits",
        raisedAt: nowIso(),
      });
      ctx.sessions.markFailed(slug);
      ctx.audit.record(
        "system",
        "session.spawn-retry.exhausted",
        { kind: "session", id: slug },
        { attempts: nextAttempts, reason },
      );
      return;
    }

    enqueueSessionSpawnRetry(deps.repo, slug, nextAttempts, backoffMs(attempts), now);
    ctx.audit.record(
      "system",
      "session.spawn-retry.deferred",
      { kind: "session", id: slug },
      { attempts: nextAttempts, reason },
    );
  };
}
