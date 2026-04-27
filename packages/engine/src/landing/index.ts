import simpleGit from "simple-git";
import type { EngineContext } from "../context.js";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import type { Logger } from "../logger.js";
import type { DagRepo } from "../dag/model.js";
import { RestackManager } from "./restack.js";
import { formatStackComment } from "./stackComment.js";
import { EngineError } from "../errors.js";

class LandingManager {
  constructor(
    private readonly ctx: EngineContext,
    private readonly dagRepo: DagRepo,
    private readonly restack: RestackManager,
    private readonly log: Logger,
  ) {}

  async land(slug: string, strategy: "merge" | "squash" | "rebase" = "squash", force = false): Promise<void> {
    const session = this.ctx.sessions.get(slug);
    if (!session) throw new EngineError("not_found", `session not found: ${slug}`);

    if (!session.worktreePath) {
      throw new EngineError("bad_request", `session ${slug} has no worktree`);
    }

    if (!force) {
      const readiness = await this.ctx.readiness.compute(slug);
      if (readiness.status !== "ready") {
        throw new EngineError(
          "conflict",
          `session ${slug} is not ready to land: ${readiness.status}`,
        );
      }
    }

    const git = simpleGit(session.worktreePath);
    const baseBranch = session.baseBranch ?? "main";
    const headBranch = session.branch;

    if (!headBranch) {
      throw new EngineError("bad_request", `session ${slug} has no branch`);
    }

    await git.fetch("origin", baseBranch);

    try {
      await git.rebase([`origin/${baseBranch}`]);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("conflict") || message.includes("CONFLICT")) {
        await git.rebase(["--abort"]).catch(() => {});
        throw new Error(`rebase conflict during land: ${message}`);
      }
      throw err;
    }

    const mainGit = simpleGit(session.worktreePath);

    if (strategy === "squash") {
      await mainGit.checkout(baseBranch);
      await mainGit.merge([headBranch, "--squash"]);
      await mainGit.commit(`Squash merge ${headBranch} into ${baseBranch}`, { "--no-edit": null });
    } else if (strategy === "rebase") {
      await mainGit.checkout(baseBranch);
      await mainGit.merge([headBranch, "--ff-only"]);
    } else {
      await mainGit.checkout(baseBranch);
      await mainGit.merge([headBranch, "--no-ff"]);
    }

    if (this.ctx.github.enabled() && session.pr) {
      try {
        const allSessions = this.ctx.sessions.list();
        const descendants = allSessions.filter(
          (s) => s.rootSlug === (session.rootSlug ?? session.slug) && s.slug !== session.slug,
        );
        const comment = formatStackComment(session, descendants);
        await this.postPRComment(session.repoId ?? "", session.pr.number, comment);
      } catch (err) {
        this.log.warn("failed to post stack comment", {
          slug,
          err: (err as Error).message,
        });
      }
    }

    this.db_setPrMerged(slug);
    this.log.info("session landed", { slug, strategy, baseBranch, headBranch });

    await this.restack.restackChildren(slug);
  }

  async retryRebase(slug: string): Promise<void> {
    const session = this.ctx.sessions.get(slug);
    if (!session) throw new EngineError("not_found", `session not found: ${slug}`);

    if (!session.worktreePath) {
      throw new EngineError("bad_request", `session ${slug} has no worktree`);
    }

    const baseBranch = session.baseBranch ?? "main";
    const git = simpleGit(session.worktreePath);

    await git.fetch("origin", baseBranch);

    try {
      await git.rebase([`origin/${baseBranch}`]);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("conflict") || message.includes("CONFLICT")) {
        await git.rebase(["--abort"]).catch(() => {});
        throw new Error(`rebase conflict: ${message}`);
      }
      throw err;
    }

    this.log.info("rebase succeeded for session", { slug, baseBranch });
  }

  private db_setPrMerged(slug: string): void {
    const session = this.ctx.sessions.get(slug);
    if (!session) return;
    if (!session.pr) return;
    this.ctx.bus.emit({
      kind: "session_updated",
      session: {
        ...session,
        pr: { ...session.pr, state: "merged" },
      },
    });
  }

  private async postPRComment(repoId: string, prNumber: number, body: string): Promise<void> {
    if (!repoId || !prNumber) return;
    const pr = await this.ctx.github.fetchPR(repoId, prNumber);
    void pr;
    this.log.info("would post PR comment", { repoId, prNumber, bodyLength: body.length });
  }
}

export function createLandingSubsystem(
  deps: SubsystemDeps & { dagRepo: DagRepo },
): SubsystemResult<EngineContext["landing"]> {
  const { ctx, log, dagRepo } = deps;

  const restack = new RestackManager(ctx, dagRepo, log.child({ subsystem: "restack" }));
  const manager = new LandingManager(
    ctx,
    dagRepo,
    restack,
    log.child({ subsystem: "landing" }),
  );

  const api: EngineContext["landing"] = {
    async land(slug: string, strategy?: "merge" | "squash" | "rebase", force?: boolean): Promise<void> {
      await manager.land(slug, strategy, force);
    },

    async retryRebase(slug: string): Promise<void> {
      await manager.retryRebase(slug);
    },
  };

  return { api };
}

export { RestackManager } from "./restack.js";
export { formatStackComment } from "./stackComment.js";
