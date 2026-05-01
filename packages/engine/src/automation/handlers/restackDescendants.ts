import type { AutomationJob, Session } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import type { DagRepo } from "../../dag/model.js";
import type { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import type { JobHandler } from "../types.js";
import { enqueueStackLand } from "./stackLand.js";

interface RestackDescendantsPayload {
  mergedSessionSlug: string;
}

export interface RestackDescendantsHandlerDeps {
  automationRepo: AutomationJobRepo;
  dagRepo: DagRepo;
  now?: () => Date;
}

export function enqueueRestackDescendants(
  repo: AutomationJobRepo,
  mergedSessionSlug: string,
): AutomationJob {
  return repo.enqueue({
    kind: "restack-descendants",
    targetKind: "session",
    targetId: mergedSessionSlug,
    payload: { mergedSessionSlug },
  });
}

function isRebaseConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /rebase conflict|conflict|CONFLICT/.test(message);
}

export function createRestackDescendantsHandler(
  deps: RestackDescendantsHandlerDeps,
): JobHandler {
  const now = deps.now ?? (() => new Date());
  return async (job: AutomationJob, ctx: EngineContext): Promise<void> => {
    const payload = job.payload as Partial<RestackDescendantsPayload>;
    const mergedSlug = payload.mergedSessionSlug;
    if (typeof mergedSlug !== "string" || mergedSlug.length === 0) return;

    const merged = ctx.sessions.get(mergedSlug);
    if (!merged || !merged.branch) return;

    const oldBase = merged.branch;
    const newBase = merged.baseBranch ?? "main";

    const all = ctx.sessions.list();
    const descendants = all.filter(
      (s: Session) =>
        s.slug !== mergedSlug &&
        s.baseBranch === oldBase &&
        !!s.pr &&
        s.pr.state === "open" &&
        s.pr.base === oldBase,
    );

    if (descendants.length === 0) {
      ctx.audit.record(
        "system",
        "restack-descendants.complete",
        { kind: "session", id: mergedSlug },
        { descendantCount: 0 },
      );
      return;
    }

    const enqueuedDagIds = new Set<string>();

    for (const desc of descendants) {
      try {
        await ctx.landing.editPRBase(desc.slug, newBase);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.audit.record(
          "system",
          "restack-descendants.edit-base-failed",
          { kind: "session", id: desc.slug },
          { mergedSessionSlug: mergedSlug, newBase, error: message },
        );
        continue;
      }

      try {
        await ctx.landing.retryRebase(desc.slug);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isRebaseConflict(err)) {
          ctx.sessions.appendAttention(desc.slug, {
            kind: "rebase_conflict",
            message: `descendant rebase failed during restack: ${message}`,
            raisedAt: now().toISOString(),
          });
          ctx.audit.record(
            "system",
            "restack-descendants.rebase-conflict",
            { kind: "session", id: desc.slug },
            { mergedSessionSlug: mergedSlug, newBase, error: message },
          );
          continue;
        }
        ctx.audit.record(
          "system",
          "restack-descendants.rebase-failed",
          { kind: "session", id: desc.slug },
          { mergedSessionSlug: mergedSlug, newBase, error: message },
        );
        continue;
      }

      const dag = deps.dagRepo.byNodeSession(desc.slug);
      if (dag && !enqueuedDagIds.has(dag.id)) {
        enqueueStackLand(deps.automationRepo, dag.id, 0, now);
        enqueuedDagIds.add(dag.id);
      }

      ctx.audit.record(
        "system",
        "restack-descendants.restacked",
        { kind: "session", id: desc.slug },
        { mergedSessionSlug: mergedSlug, newBase, dagId: dag?.id },
      );
    }

    ctx.audit.record(
      "system",
      "restack-descendants.complete",
      { kind: "session", id: mergedSlug },
      { descendantCount: descendants.length },
    );
  };
}
