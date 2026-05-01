import type { AutomationJob, Session } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import type { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import type { JobHandler } from "../types.js";

interface CiFailureFixPayload {
  sessionSlug: string;
}

export interface CiFailureFixHandlerDeps {
  automationRepo: AutomationJobRepo;
}

export function enqueueCiFailureFix(
  repo: AutomationJobRepo,
  sessionSlug: string,
): AutomationJob | null {
  const existing = repo.findByTarget("session", sessionSlug);
  const inFlight = existing.some(
    (j) =>
      j.kind === "ci-failure-fix" && (j.status === "pending" || j.status === "running"),
  );
  if (inFlight) return null;
  return repo.enqueue({
    kind: "ci-failure-fix",
    targetKind: "session",
    targetId: sessionSlug,
    payload: { sessionSlug },
  });
}

function hasActiveFixCiChild(session: Session, ctx: EngineContext): boolean {
  const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
  for (const childSlug of session.childSlugs) {
    const child = ctx.sessions.get(childSlug);
    if (!child) continue;
    if (child.metadata["kind"] === "fix-ci" && !terminalStatuses.has(child.status)) {
      return true;
    }
  }
  return false;
}

export function createCiFailureFixHandler(deps: CiFailureFixHandlerDeps): JobHandler {
  return async (job: AutomationJob, ctx: EngineContext): Promise<void> => {
    const payload = job.payload as Partial<CiFailureFixPayload>;
    const slug = payload.sessionSlug;
    if (typeof slug !== "string" || slug.length === 0) return;

    const flagEnabled = ctx.runtime.effective()["autoFixCiOnFailure"] === true;
    if (!flagEnabled) return;

    const session = ctx.sessions.get(slug);
    if (!session) return;

    if (session.metadata["kind"] === "fix-ci") return;

    if (!session.pr || session.pr.state !== "open") return;

    const ciFailedFlag = session.attention.find((a) => a.kind === "ci_failed");
    if (!ciFailedFlag) return;

    if (hasActiveFixCiChild(session, ctx)) return;

    const prNumber = session.pr.number;
    const prUrl = session.pr.url;
    const failureMessage = ciFailedFlag.message;

    try {
      await ctx.sessions.create({
        mode: "task",
        parentSlug: slug,
        prompt:
          `CI is failing on PR #${prNumber} (${prUrl}).\n\n` +
          `Failure summary:\n${failureMessage}\n\n` +
          `Investigate the failure, fix the underlying cause, and push a commit. ` +
          `Do not bypass hooks or skip checks.`,
        repoId: session.repoId,
        baseBranch: session.branch,
        metadata: { kind: "fix-ci", forSession: slug },
      });
    } catch (err) {
      ctx.log.warn("ciFailureFix: failed to spawn fix-CI sub-session", {
        slug,
        err: (err as Error).message,
      });
    }
  };
}
