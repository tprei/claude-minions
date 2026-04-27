import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { parseOwnerRepo } from "./githubClient.js";
import { onPrUpdated as handlePrUpdated } from "./prLifecycle.js";
import { CiBabysitter } from "./babysitter.js";

export interface CiSubsystem {
  poll: (slug: string) => Promise<void>;
  onPrUpdated: (slug: string) => Promise<void>;
}

export function createCiSubsystem(deps: SubsystemDeps): SubsystemResult<CiSubsystem> {
  const { ctx, log, db } = deps;

  const babysitter = new CiBabysitter(ctx, log);

  async function poll(slug: string): Promise<void> {
    const session = ctx.sessions.get(slug);
    if (!session || !session.pr) return;

    if (!ctx.github.enabled()) {
      log.debug("ci poll skipped: github not enabled", { slug });
      return;
    }

    if (!session.repoId) return;

    const repos = ctx.repos();
    const repo = repos.find((r) => r.id === session.repoId);
    if (!repo?.remote) return;

    try {
      parseOwnerRepo(repo.remote);
    } catch (err) {
      log.warn("ci poll: cannot parse remote", { slug, remote: repo.remote, err: (err as Error).message });
      return;
    }

    try {
      const pr = await ctx.github.fetchPR(session.repoId, session.pr.number);

      const hasFailure = pr.checks.some(
        (c) =>
          c.status === "completed" &&
          (c.conclusion === "failure" || c.conclusion === "timed_out" || c.conclusion === "action_required"),
      );

      if (hasFailure) {
        const existing = session.attention.find((a) => a.kind === "ci_failed");
        if (!existing) {
          const updated = ctx.sessions.get(slug);
          if (updated) {
            const attention = [
              ...updated.attention,
              {
                kind: "ci_failed" as const,
                message: "One or more CI checks failed",
                raisedAt: new Date().toISOString(),
              },
            ];

            db.prepare("UPDATE sessions SET attention=?, updated_at=? WHERE slug=?").run(
              JSON.stringify(attention),
              new Date().toISOString(),
              slug,
            );

            const fresh = ctx.sessions.get(slug);
            if (fresh) {
              ctx.bus.emit({ kind: "session_updated", session: fresh });
            }

            const autoFix = ctx.runtime.effective()["ciAutoFix"];
            if (autoFix === true) {
              await ctx.sessions.create({
                mode: "task",
                prompt: `Fix CI failures for session ${slug}. Check the failing checks and resolve them.`,
                repoId: session.repoId,
                baseBranch: session.baseBranch,
                parentSlug: slug,
                metadata: { ciAutoFix: true, fixingSession: slug },
              }).catch((e) => {
                log.warn("ci auto-fix session spawn failed", { slug, err: (e as Error).message });
              });
            }
          }
        }
      }

      await handlePrUpdated(slug, ctx, log);
    } catch (err) {
      log.warn("ci poll error", { slug, err: (err as Error).message });
    }
  }

  async function onPrUpdated(slug: string): Promise<void> {
    await handlePrUpdated(slug, ctx, log);
  }

  babysitter.start();

  return {
    api: { poll, onPrUpdated },
    onShutdown() {
      babysitter.stop();
    },
  };
}
