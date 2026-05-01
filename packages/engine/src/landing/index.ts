import simpleGit from "simple-git";
import type { PRSummary, Session } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import type { Logger } from "../logger.js";
import type { DagRepo } from "../dag/model.js";
import { RestackManager } from "./restack.js";
import { formatStackComment } from "./stackComment.js";
import { pushBranch as defaultPushBranch } from "./push.js";
import { commitsAhead as defaultCommitsAhead, type CommitsAheadFn } from "./commitsAhead.js";
import { ensurePullRequest as defaultEnsurePullRequest, type EnsurePullRequestArgs } from "./openPR.js";
import {
  editPullRequestBase as defaultEditPullRequestBase,
  type EditPullRequestBaseFn,
} from "./editPRBase.js";
import {
  applyLiveBase,
  defaultBranchExists,
  defaultRebaseOnto,
  type BranchExistsFn,
  type RebaseOntoFn,
} from "./baseResolver.js";
import { EngineError } from "../errors.js";
import { SessionRepo } from "../store/repos/sessionRepo.js";
import type { SessionStateUpdater } from "./sessionStateUpdater.js";
import { AutomationJobRepo } from "../store/repos/automationJobRepo.js";
import { enqueueRestackDescendants } from "../automation/handlers/restackDescendants.js";

export type PushBranchFn = (worktreePath: string, branch: string, log: Logger) => Promise<void>;
export type EnsurePullRequestFn = (args: EnsurePullRequestArgs) => Promise<PRSummary | null>;
export type { EditPullRequestBaseFn } from "./editPRBase.js";
export type { CommitsAheadFn } from "./commitsAhead.js";

export type { SessionStateUpdater } from "./sessionStateUpdater.js";

export interface LandingManagerDeps {
  pushBranch?: PushBranchFn;
  ensurePullRequest?: EnsurePullRequestFn;
  editPullRequestBase?: EditPullRequestBaseFn;
  branchExistsOnRemote?: BranchExistsFn;
  rebaseOnto?: RebaseOntoFn;
  commitsAhead?: CommitsAheadFn;
  sessionRepo?: SessionStateUpdater | null;
  automationRepo?: AutomationJobRepo | null;
}

function isOnlineRemote(remote: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git:\/\/|git@)/.test(remote);
}

export class LandingManager {
  private readonly pushBranch: PushBranchFn;
  private readonly ensurePullRequest: EnsurePullRequestFn;
  private readonly editPullRequestBase: EditPullRequestBaseFn;
  private readonly branchExistsOnRemote: BranchExistsFn;
  private readonly rebaseOnto: RebaseOntoFn;
  private readonly commitsAhead: CommitsAheadFn;
  private readonly sessionRepo: SessionStateUpdater | null;
  private readonly automationRepo: AutomationJobRepo | null;

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
    this.branchExistsOnRemote = deps.branchExistsOnRemote ?? defaultBranchExists;
    this.rebaseOnto = deps.rebaseOnto ?? defaultRebaseOnto;
    this.commitsAhead = deps.commitsAhead ?? defaultCommitsAhead;
    this.sessionRepo = deps.sessionRepo ?? null;
    this.automationRepo = deps.automationRepo ?? null;
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
      const preMerge = await this.inspectPrBeforeMerge(prNumber, session.repoId ?? "", slug);
      if (preMerge.action === "skip") {
        this.log.info("merge skipped: PR no longer in mergeable state", {
          slug,
          prNumber,
          reason: preMerge.reason,
        });
        return;
      }
      if (preMerge.action === "conflict") {
        this.ctx.sessions.appendAttention(slug, {
          kind: "rebase_conflict",
          message: `PR #${prNumber} has merge conflicts on GitHub; rebase required before landing.`,
          raisedAt: new Date().toISOString(),
        });
        this.ctx.audit.record(
          "system",
          "landing.merge.blocked",
          { kind: "session", id: slug },
          { prNumber, reason: "conflicting" },
        );
        return;
      }
      const repoId = session.repoId ?? "";
      try {
        await this.ctx.github.mergePR(repoId, prNumber, { strategy });
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

    try {
      await this.ctx.dags.onSessionPrMerged(slug);
    } catch (err) {
      this.log.warn("dag onSessionPrMerged failed", {
        slug,
        err: (err as Error).message,
      });
    }

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

    await applyLiveBase(slug, {
      ctx: this.ctx,
      dagRepo: this.dagRepo,
      log: this.log,
      sessionRepo: this.sessionRepo,
      branchExists: this.branchExistsOnRemote,
      rebaseOnto: this.rebaseOnto,
    });

    const refreshedAfterBase = this.ctx.sessions.get(slug) ?? session;
    const baseForCount = refreshedAfterBase.baseBranch ?? session.baseBranch ?? "main";

    let ahead = 0;
    try {
      ahead = await this.commitsAhead(session.worktreePath, session.branch, baseForCount);
    } catch (err) {
      this.log.warn("commitsAhead probe failed; proceeding with push attempt", {
        slug,
        baseBranch: baseForCount,
        head: session.branch,
        err: (err as Error).message,
      });
    }
    if (ahead === 0) {
      this.log.info("ensurePushedAndPRed skipped: no commits ahead of base", {
        slug,
        baseBranch: baseForCount,
        head: session.branch,
      });
      this.ctx.audit.record(
        "system",
        "landing.no-changes",
        { kind: "session", id: slug },
        { branch: session.branch, baseBranch: baseForCount },
      );
      return;
    }

    this.ctx.audit.record(
      "system",
      "landing.push.start",
      { kind: "session", id: slug },
      { branch: refreshedAfterBase.branch, baseBranch: refreshedAfterBase.baseBranch ?? null },
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
      { branch: refreshedAfterBase.branch, baseBranch: refreshedAfterBase.baseBranch ?? null },
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

    if (onlineFlow && child.pr && child.repoId) {
      try {
        await this.editPullRequestBase({
          ctx: this.ctx,
          repoId: child.repoId,
          prNumber: child.pr.number,
          newBase,
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

  async editPRBase(slug: string, newBase: string): Promise<void> {
    const session = this.ctx.sessions.get(slug);
    if (!session) throw new EngineError("not_found", `session not found: ${slug}`);
    if (!session.pr) {
      throw new EngineError("bad_request", `session ${slug} has no PR`);
    }
    if (!session.worktreePath) {
      throw new EngineError("bad_request", `session ${slug} has no worktree`);
    }

    await this.editPullRequestBase({
      ctx: this.ctx,
      repoId: session.repoId ?? "",
      prNumber: session.pr.number,
      newBase,
      log: this.log,
    });

    if (this.sessionRepo) {
      this.sessionRepo.update(slug, { baseBranch: newBase });
      this.sessionRepo.setPr(slug, { ...session.pr, base: newBase });
    }
  }

  private async inspectPrBeforeMerge(
    prNumber: number,
    repoId: string,
    slug: string,
  ): Promise<{ action: "merge" } | { action: "skip"; reason: string } | { action: "conflict" }> {
    let pr: import("@minions/shared").PullRequestPreview;
    try {
      pr = await this.ctx.github.fetchPR(repoId, prNumber);
    } catch (err) {
      this.log.warn("fetchPR failed before merge; proceeding optimistically", {
        slug,
        prNumber,
        err: (err as Error).message,
      });
      return { action: "merge" };
    }

    if (pr.state !== "open") {
      const reason = pr.state === "merged" ? "already-merged" : pr.state === "closed" ? "closed" : pr.state;
      this.ctx.audit.record(
        "system",
        "landing.merge.skipped",
        { kind: "session", id: slug },
        { prNumber, reason, state: pr.state },
      );
      return { action: "skip", reason };
    }

    if (pr.mergeableState === "dirty") {
      return { action: "conflict" };
    }

    return { action: "merge" };
  }

  private db_setPrMerged(slug: string): void {
    const session = this.ctx.sessions.get(slug);
    if (!session) return;
    if (!session.pr) return;
    const merged: PRSummary = { ...session.pr, state: "merged" };
    if (this.sessionRepo) {
      this.sessionRepo.setPr(slug, merged);
    }
    this.ctx.bus.emit({
      kind: "session_updated",
      session: { ...session, pr: merged },
    });
    if (this.automationRepo) {
      try {
        enqueueRestackDescendants(this.automationRepo, slug);
      } catch (err) {
        this.log.warn("failed to enqueue restack-descendants", {
          slug,
          err: (err as Error).message,
        });
      }
    }
  }

  private async postPRComment(repoId: string, prNumber: number, body: string): Promise<void> {
    if (!repoId || !prNumber) return;
    await this.ctx.github.postPRComment(repoId, prNumber, body);
  }
}

export function createLandingSubsystem(
  deps: SubsystemDeps & { dagRepo: DagRepo; automationRepo?: AutomationJobRepo | null },
): SubsystemResult<EngineContext["landing"]> {
  const { ctx, log, dagRepo, db, automationRepo } = deps;

  const sessionRepo = new SessionRepo(db);
  const restack = new RestackManager(ctx, dagRepo, log.child({ subsystem: "restack" }), {
    sessionRepo,
  });
  const manager = new LandingManager(
    ctx,
    dagRepo,
    restack,
    log.child({ subsystem: "landing" }),
    { sessionRepo, automationRepo: automationRepo ?? null },
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

    async editPRBase(slug: string, newBase: string): Promise<void> {
      await manager.editPRBase(slug, newBase);
    },
  };

  return { api };
}

export { RestackManager } from "./restack.js";
export { formatStackComment } from "./stackComment.js";
