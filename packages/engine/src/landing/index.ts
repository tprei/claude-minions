import { spawn } from "node:child_process";
import simpleGit from "simple-git";
import type { PRSummary, Session } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import type { Logger } from "../logger.js";
import type { DagRepo } from "../dag/model.js";
import { RestackManager } from "./restack.js";
import { formatStackComment } from "./stackComment.js";
import { pushBranch as defaultPushBranch } from "./push.js";
import { ensurePullRequest as defaultEnsurePullRequest, type EnsurePullRequestArgs } from "./openPR.js";
import {
  createEditPullRequestBase,
  defaultRunGh,
  type EditPullRequestBaseFn,
} from "./editPRBase.js";
import { EngineError } from "../errors.js";
import { SessionRepo } from "../store/repos/sessionRepo.js";

export type PushBranchFn = (worktreePath: string, branch: string, log: Logger) => Promise<void>;
export type EnsurePullRequestFn = (args: EnsurePullRequestArgs) => Promise<PRSummary | null>;
export type { EditPullRequestBaseFn } from "./editPRBase.js";

export interface SessionStateUpdater {
  update(slug: string, patch: { baseBranch?: string }): void;
  setPr(slug: string, pr: PRSummary | null): void;
}

export interface LandingManagerDeps {
  pushBranch?: PushBranchFn;
  ensurePullRequest?: EnsurePullRequestFn;
  editPullRequestBase?: EditPullRequestBaseFn;
  sessionRepo?: SessionStateUpdater | null;
}

function isOnlineRemote(remote: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git:\/\/|git@)/.test(remote);
}

function runGh(args: string[], opts: { cwd: string; log: Logger }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { cwd: opts.cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        opts.log.info("gh ok", { args: args.join(" ") });
        resolve(stdout.trim());
      } else {
        reject(new Error(`gh ${args.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });
  });
}

const defaultEditPullRequestBase: EditPullRequestBaseFn = createEditPullRequestBase(defaultRunGh);

export class LandingManager {
  private readonly pushBranch: PushBranchFn;
  private readonly ensurePullRequest: EnsurePullRequestFn;
  private readonly editPullRequestBase: EditPullRequestBaseFn;
  private readonly sessionRepo: SessionStateUpdater | null;

  constructor(
    private readonly ctx: EngineContext,
    private readonly dagRepo: DagRepo,
    private readonly restack: RestackManager,
    private readonly log: Logger,
    deps: LandingManagerDeps = {},
  ) {
    this.pushBranch = deps.pushBranch ?? defaultPushBranch;
    this.ensurePullRequest = deps.ensurePullRequest ?? defaultEnsurePullRequest;
    this.editPullRequestBase = deps.editPullRequestBase ?? defaultEditPullRequestBase;
    this.sessionRepo = deps.sessionRepo ?? null;
  }

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

    const refreshedAfterPush = this.ctx.sessions.get(slug) ?? session;
    const repo = session.repoId ? this.ctx.repos().find((r) => r.id === session.repoId) : undefined;
    const onlineFlow = !!(repo?.remote && isOnlineRemote(repo.remote)) && !!refreshedAfterPush.pr;

    if (onlineFlow && refreshedAfterPush.pr) {
      const prNumber = refreshedAfterPush.pr.number;
      const flag = strategy === "squash" ? "--squash" : strategy === "rebase" ? "--rebase" : "--merge";
      const args = ["pr", "merge", String(prNumber), flag, "--delete-branch=false"];
      try {
        await runGh(args, { cwd: session.worktreePath, log: this.log });
      } catch (err) {
        throw new EngineError(
          "upstream",
          `failed to merge PR #${prNumber} on GitHub: ${(err as Error).message}`,
        );
      }
      try {
        await git.fetch("origin", baseBranch);
      } catch {
        /* best effort */
      }
    } else {
      try {
        await git.fetch("origin", baseBranch);
      } catch {
        /* best effort — local-only flows may not have an upstream ref */
      }

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

  async openForReview(slug: string): Promise<PRSummary | null> {
    const session = this.ctx.sessions.get(slug);
    if (!session) throw new EngineError("not_found", `session not found: ${slug}`);
    if (!session.worktreePath) {
      throw new EngineError("bad_request", `session ${slug} has no worktree`);
    }
    if (!session.branch) {
      throw new EngineError("bad_request", `session ${slug} has no branch`);
    }

    await this.ensurePushedAndPRed(slug);

    const refreshed = this.ctx.sessions.get(slug);
    return refreshed?.pr ?? null;
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
      this.ctx.audit.record(
        "system",
        "landing.push_and_pr.skipped",
        { kind: "session", id: slug },
        { reason: "no-repo-id" },
      );
      return;
    }

    const repo = this.ctx.repos().find((r) => r.id === session.repoId);
    if (!repo?.remote) {
      this.log.info("ensurePushedAndPRed skipped: repo has no remote", {
        slug,
        repoId: session.repoId,
      });
      this.ctx.audit.record(
        "system",
        "landing.push_and_pr.skipped",
        { kind: "session", id: slug },
        { reason: "no-remote", repoId: session.repoId },
      );
      return;
    }

    if (!isOnlineRemote(repo.remote)) {
      this.log.info("ensurePushedAndPRed skipped: remote is local file path (offline mode)", {
        slug,
        remote: repo.remote,
      });
      this.ctx.audit.record(
        "system",
        "landing.push_and_pr.skipped",
        { kind: "session", id: slug },
        { reason: "offline-remote", remote: repo.remote },
      );
      return;
    }

    this.ctx.audit.record(
      "system",
      "landing.push.start",
      { kind: "session", id: slug },
      { branch: session.branch, baseBranch: session.baseBranch ?? null },
    );
    try {
      await this.pushBranch(session.worktreePath, session.branch, this.log);
    } catch (err) {
      this.ctx.audit.record(
        "system",
        "landing.push.failed",
        { kind: "session", id: slug },
        { branch: session.branch, error: (err as Error).message },
      );
      throw err;
    }
    this.ctx.audit.record(
      "system",
      "landing.push.complete",
      { kind: "session", id: slug },
      { branch: session.branch },
    );

    this.ctx.audit.record(
      "system",
      "landing.pr.ensure.start",
      { kind: "session", id: slug },
      { branch: session.branch, baseBranch: session.baseBranch ?? null },
    );
    try {
      await this.ensurePullRequest({ ctx: this.ctx, slug, log: this.log });
    } catch (err) {
      this.ctx.audit.record(
        "system",
        "landing.pr.ensure.failed",
        { kind: "session", id: slug },
        { branch: session.branch, error: (err as Error).message },
      );
      throw err;
    }
    this.ctx.audit.record(
      "system",
      "landing.pr.ensure.complete",
      { kind: "session", id: slug },
      { branch: session.branch },
    );
  }

  async onUpstreamMerged(parentSlug: string): Promise<void> {
    const parent = this.ctx.sessions.get(parentSlug);
    if (!parent || !parent.branch) return;
    const oldBase = parent.branch;
    const newBase = parent.baseBranch ?? "main";

    this.log.info("upstream merged: restacking children", {
      parent: parentSlug,
      oldBase,
      newBase,
    });
    this.ctx.audit.record(
      "system",
      "landing.upstream_merged",
      { kind: "session", id: parentSlug },
      { oldBase, newBase },
    );

    const allSessions = this.ctx.sessions.list();
    const childSessions = allSessions.filter(
      (s) => s.baseBranch === oldBase && s.slug !== parentSlug,
    );

    for (const child of childSessions) {
      await this.rebaseChildOntoNewBase(child, newBase);
    }

    const handledSlugs = new Set(childSessions.map((c) => c.slug));
    const allDags = this.dagRepo.list();
    for (const dag of allDags) {
      for (const node of dag.nodes) {
        if (node.baseBranch !== oldBase || !node.sessionSlug) continue;
        try {
          this.dagRepo.updateNode(node.id, { baseBranch: newBase });
        } catch (err) {
          this.log.warn("failed to update dag node base", {
            dagId: dag.id,
            nodeId: node.id,
            err: (err as Error).message,
          });
        }
        if (handledSlugs.has(node.sessionSlug)) continue;
        const childSession = this.ctx.sessions.get(node.sessionSlug);
        if (!childSession) continue;
        await this.rebaseChildOntoNewBase(childSession, newBase);
        handledSlugs.add(node.sessionSlug);
      }
    }
  }

  private async rebaseChildOntoNewBase(child: Session, newBase: string): Promise<void> {
    if (this.sessionRepo) {
      this.sessionRepo.update(child.slug, { baseBranch: newBase });
    }

    const repo = child.repoId ? this.ctx.repos().find((r) => r.id === child.repoId) : undefined;
    const onlineFlow =
      !!(repo?.remote && isOnlineRemote(repo.remote)) &&
      !!child.pr &&
      child.pr.state === "open";

    if (onlineFlow && child.pr && child.worktreePath && repo?.remote) {
      try {
        await this.editPullRequestBase({
          cwd: child.worktreePath,
          prNumber: child.pr.number,
          newBase,
          remote: repo.remote,
          log: this.log,
        });
        if (this.sessionRepo) {
          this.sessionRepo.setPr(child.slug, { ...child.pr, base: newBase });
        }
      } catch (err) {
        const message = (err as Error).message;
        this.log.warn("failed to update child PR base on GitHub", {
          child: child.slug,
          prNumber: child.pr.number,
          err: message,
        });
        this.ctx.audit.record(
          "system",
          "landing.pr.edit_base.failed",
          { kind: "session", id: child.slug },
          { prNumber: child.pr.number, newBase, error: message },
        );
      }
    }

    const refreshed = this.ctx.sessions.get(child.slug);
    if (refreshed) {
      this.ctx.bus.emit({ kind: "session_updated", session: refreshed });
    }

    await this.restack.restackChild(child.slug, newBase);
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
  const { ctx, log, dagRepo, db } = deps;

  const sessionRepo = new SessionRepo(db);
  const restack = new RestackManager(ctx, dagRepo, log.child({ subsystem: "restack" }));
  const manager = new LandingManager(
    ctx,
    dagRepo,
    restack,
    log.child({ subsystem: "landing" }),
    { sessionRepo },
  );

  const api: EngineContext["landing"] = {
    async land(slug: string, strategy?: "merge" | "squash" | "rebase", force?: boolean): Promise<void> {
      await manager.land(slug, strategy, force);
    },

    async openForReview(slug: string): Promise<PRSummary | null> {
      return manager.openForReview(slug);
    },

    async retryRebase(slug: string): Promise<void> {
      await manager.retryRebase(slug);
    },

    async onUpstreamMerged(slug: string): Promise<void> {
      await manager.onUpstreamMerged(slug);
    },
  };

  return { api };
}

export { RestackManager } from "./restack.js";
export { formatStackComment } from "./stackComment.js";
