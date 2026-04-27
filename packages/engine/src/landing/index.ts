import simpleGit from "simple-git";
import type { EngineContext } from "../context.js";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import type { Logger } from "../logger.js";
import type { DagRepo } from "../dag/model.js";
import { RestackManager } from "./restack.js";
import { formatStackComment } from "./stackComment.js";
import { pushBranch } from "./push.js";
import { ensurePullRequest } from "./openPR.js";
import { EngineError } from "../errors.js";

function isOnlineRemote(remote: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git:\/\/|git@)/.test(remote);
}

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

    await this.ensurePushedAndPRed(slug);

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

    if (session.repoId) {
      const repo = this.ctx.repos().find((r) => r.id === session.repoId);
      if (repo?.remote && isOnlineRemote(repo.remote)) {
        try {
          await mainGit.push("origin", baseBranch);
        } catch (err) {
          throw new EngineError(
            "upstream",
            `failed to push ${baseBranch} to origin: ${(err as Error).message}`,
          );
        }
      }
    }

    const refreshed = this.ctx.sessions.get(slug) ?? session;
    if (this.ctx.github.enabled() && refreshed.pr) {
      try {
        const allSessions = this.ctx.sessions.list();
        const descendants = allSessions.filter(
          (s) => s.rootSlug === (refreshed.rootSlug ?? refreshed.slug) && s.slug !== refreshed.slug,
        );
        const comment = formatStackComment(refreshed, descendants);
        await this.postPRComment(refreshed.repoId ?? "", refreshed.pr.number, comment);
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

  async ensurePushedAndPRed(slug: string): Promise<void> {
    const session = this.ctx.sessions.get(slug);
    if (!session) throw new EngineError("not_found", `session not found: ${slug}`);

    if (!session.worktreePath) {
      throw new EngineError("bad_request", `session ${slug} has no worktree`);
    }
    if (!session.branch) {
      throw new EngineError("bad_request", `session ${slug} has no branch`);
    }

    if (!session.repoId) {
      this.log.info("ensurePushedAndPRed skipped: session has no repoId", { slug });
      return;
    }

    const repo = this.ctx.repos().find((r) => r.id === session.repoId);
    if (!repo?.remote) {
      this.log.info("ensurePushedAndPRed skipped: repo has no remote", {
        slug,
        repoId: session.repoId,
      });
      return;
    }

    if (!isOnlineRemote(repo.remote)) {
      this.log.info("ensurePushedAndPRed skipped: remote is local file path (offline mode)", {
        slug,
        remote: repo.remote,
      });
      return;
    }

    await pushBranch(session.worktreePath, session.branch, this.log);
    await ensurePullRequest({ ctx: this.ctx, slug, log: this.log });
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
