import type { CreateVariantsRequest } from "@minions/shared";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { listenForVariantCompletions } from "./runner.js";
import { runJudge } from "./judge.js";

export interface VariantsSubsystem {
  spawn: (req: CreateVariantsRequest) => Promise<{ parentSlug: string; childSlugs: string[] }>;
  judge: (parentSlug: string, rubric?: string) => Promise<void>;
}

export function createVariantsSubsystem(deps: SubsystemDeps): SubsystemResult<VariantsSubsystem> {
  const { ctx, log, bus } = deps;

  async function spawn(
    req: CreateVariantsRequest,
  ): Promise<{ parentSlug: string; childSlugs: string[] }> {
    const count = Math.max(1, Math.min(req.count, 10));

    const parentSession = await ctx.sessions.create({
      mode: "task",
      prompt: req.prompt,
      repoId: req.repoId,
      baseBranch: req.baseBranch,
      modelHint: req.modelHint,
      metadata: { variantParent: true, variantCount: count },
    });
    const parentSlug = parentSession.slug;

    const childSlugs: string[] = [];
    const childPromises: Promise<void>[] = [];

    for (let i = 0; i < count; i++) {
      const p = ctx.sessions.create({
        mode: "task",
        prompt: req.prompt,
        repoId: req.repoId,
        baseBranch: req.baseBranch,
        modelHint: req.modelHint,
        parentSlug,
        metadata: { variantOf: parentSlug, variantIndex: i },
      }).then((s) => {
        childSlugs.push(s.slug);
      });
      childPromises.push(p);
    }

    await Promise.all(childPromises);

    log.info("variants spawned", { parentSlug, childSlugs, count });

    listenForVariantCompletions(parentSlug, childSlugs, bus, (done) => {
      log.info("all variants done, running judge", { parentSlug, done });
      runJudge(ctx, parentSlug, done, req.judgeRubric, log).catch((err) => {
        log.error("judge error", { parentSlug, err: (err as Error).message });
      });
    });

    return { parentSlug, childSlugs };
  }

  async function judge(parentSlug: string, rubric?: string): Promise<void> {
    const sessions = ctx.sessions.list();
    const children = sessions.filter(
      (s) => s.parentSlug === parentSlug && s.metadata["variantOf"] === parentSlug,
    );
    const childSlugs = children.map((s) => s.slug);
    await runJudge(ctx, parentSlug, childSlugs, rubric, log);
  }

  return {
    api: { spawn, judge },
  };
}
