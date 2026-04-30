import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";
import type { DagRepo } from "../dag/model.js";
import {
  applyLiveBase,
  defaultBranchExists,
  defaultRebaseOnto,
  type BranchExistsFn,
  type RebaseOntoFn,
} from "./baseResolver.js";
import type { SessionStateUpdater } from "./sessionStateUpdater.js";

export interface RestackManagerDeps {
  branchExistsOnRemote?: BranchExistsFn;
  rebaseOnto?: RebaseOntoFn;
  sessionRepo?: SessionStateUpdater | null;
}

export class RestackManager {
  private readonly branchExistsOnRemote: BranchExistsFn;
  private readonly rebaseOnto: RebaseOntoFn;
  private readonly sessionRepo: SessionStateUpdater | null;

  constructor(
    private readonly ctx: EngineContext,
    private readonly dagRepo: DagRepo,
    private readonly log: Logger,
    deps: RestackManagerDeps = {},
  ) {
    this.branchExistsOnRemote = deps.branchExistsOnRemote ?? defaultBranchExists;
    this.rebaseOnto = deps.rebaseOnto ?? defaultRebaseOnto;
    this.sessionRepo = deps.sessionRepo ?? null;
  }

  private async ensureBaseLive(slug: string): Promise<void> {
    await applyLiveBase(slug, {
      ctx: this.ctx,
      dagRepo: this.dagRepo,
      log: this.log,
      sessionRepo: this.sessionRepo,
      branchExists: this.branchExistsOnRemote,
      rebaseOnto: this.rebaseOnto,
    });
  }

  async restackChild(slug: string, newBase: string): Promise<void> {
    await this.restackSession(slug, newBase);
  }

  async restackDagChild(
    dagId: string,
    nodeId: string,
    sessionSlug: string,
    newBase: string,
  ): Promise<void> {
    await this.restackDagNode(dagId, nodeId, sessionSlug, newBase);
  }

  async restackChildren(landedSlug: string): Promise<void> {
    const landedSession = this.ctx.sessions.get(landedSlug);
    if (!landedSession) return;

    const landedBranch = landedSession.branch;
    if (!landedBranch) return;

    const allSessions = this.ctx.sessions.list();
    const children = allSessions.filter(
      (s) => s.baseBranch === landedBranch && s.slug !== landedSlug,
    );

    for (const child of children) {
      await this.restackSession(child.slug, landedBranch);
    }

    const allDags = this.dagRepo.list();
    for (const dag of allDags) {
      for (const node of dag.nodes) {
        if (node.baseBranch === landedBranch && node.sessionSlug) {
          await this.restackDagNode(dag.id, node.id, node.sessionSlug, landedBranch);
        }
      }
    }
  }

  private async restackSession(slug: string, newBase: string): Promise<void> {
    const session = this.ctx.sessions.get(slug);
    if (!session) return;

    if (session.status === "completed" || session.status === "failed" || session.status === "cancelled") {
      return;
    }

    this.log.info("restacking session", { slug, newBase });

    try {
      await this.runUnderSlugMutex(slug, "restack:session", { newBase }, async () => {
        await this.ensureBaseLive(slug);
        await this.ctx.landing.retryRebase(slug);
      });
    } catch (err) {
      const message = (err as Error).message;
      this.log.error("restack failed for session", { slug, err: message });

      const current = this.ctx.sessions.get(slug);
      if (!current) return;

      const flags = [
        ...current.attention,
        {
          kind: "rebase_conflict" as const,
          message: `Restack conflict after landing ${newBase}: ${message}`,
          raisedAt: new Date().toISOString(),
        },
      ];
      this.ctx.bus.emit({ kind: "session_updated", session: { ...current, attention: flags } });

      await this.spawnRebaseResolverForSession(slug, message);
    }
  }

  private async restackDagNode(
    dagId: string,
    nodeId: string,
    sessionSlug: string,
    newBase: string,
  ): Promise<void> {
    const session = this.ctx.sessions.get(sessionSlug);
    if (!session) return;

    this.log.info("restacking dag node session", { dagId, nodeId, sessionSlug, newBase });

    try {
      await this.runUnderSlugMutex(
        sessionSlug,
        "restack:dag-node",
        { dagId, nodeId, newBase },
        async () => {
          await this.ensureBaseLive(sessionSlug);
          await this.ctx.landing.retryRebase(sessionSlug);
        },
      );
    } catch (err) {
      const message = (err as Error).message;
      this.log.error("restack failed for dag node", { dagId, nodeId, sessionSlug, err: message });

      this.dagRepo.updateNode(nodeId, {
        status: "rebase-conflict",
        failedReason: message,
      });

      const current = this.ctx.sessions.get(sessionSlug);
      if (!current) return;

      const flags = [
        ...current.attention,
        {
          kind: "rebase_conflict" as const,
          message: `Restack conflict: ${message}`,
          raisedAt: new Date().toISOString(),
        },
      ];
      this.ctx.bus.emit({ kind: "session_updated", session: { ...current, attention: flags } });

      await this.spawnRebaseResolverForDagNode(dagId, nodeId, sessionSlug, message);
    }
  }

  private async runUnderSlugMutex<T>(
    slug: string,
    action: string,
    detail: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.ctx.audit.record("restack", `${action}:mutex-acquire`, { kind: "session", id: slug }, detail);
    try {
      return await this.ctx.mutex.run(slug, fn);
    } finally {
      this.ctx.audit.record("restack", `${action}:mutex-release`, { kind: "session", id: slug }, detail);
    }
  }

  private async spawnRebaseResolverForSession(
    conflictSlug: string,
    conflictMessage: string,
  ): Promise<void> {
    const session = this.ctx.sessions.get(conflictSlug);
    if (!session) return;

    const prompt =
      `A rebase conflict occurred while restacking session ${conflictSlug}.\n\n` +
      `Error: ${conflictMessage}\n\n` +
      `Please resolve the conflict markers in the worktree at: ${session.worktreePath ?? "unknown"}.\n` +
      `Look for files containing <<<<<<, =======, and >>>>>>> markers and resolve them.\n` +
      `After resolving, complete the rebase with \`git rebase --continue\`.`;

    try {
      await this.ctx.sessions.create({
        prompt,
        mode: "rebase-resolver",
        title: `Rebase resolver for ${conflictSlug}`,
        repoId: session.repoId,
        baseBranch: session.baseBranch,
        parentSlug: conflictSlug,
        metadata: { conflictSessionSlug: conflictSlug },
      });
    } catch (err) {
      this.log.error("failed to spawn rebase-resolver session", {
        conflictSlug,
        err: (err as Error).message,
      });
    }
  }

  private async spawnRebaseResolverForDagNode(
    dagId: string,
    nodeId: string,
    conflictSessionSlug: string,
    conflictMessage: string,
  ): Promise<void> {
    const session = this.ctx.sessions.get(conflictSessionSlug);
    if (!session) return;

    const prompt =
      `A rebase conflict occurred while restacking DAG node ${nodeId} in DAG ${dagId}.\n\n` +
      `Session: ${conflictSessionSlug}\n` +
      `Error: ${conflictMessage}\n\n` +
      `Please resolve the conflict markers in the worktree at: ${session.worktreePath ?? "unknown"}.\n` +
      `Look for files containing <<<<<<, =======, and >>>>>>> markers and resolve them.\n` +
      `After resolving, complete the rebase with \`git rebase --continue\`.`;

    try {
      await this.ctx.sessions.create({
        prompt,
        mode: "rebase-resolver",
        title: `Rebase resolver for node ${nodeId}`,
        repoId: session.repoId,
        baseBranch: session.baseBranch,
        parentSlug: conflictSessionSlug,
        metadata: { dagId, dagNodeId: nodeId, conflictSessionSlug },
      });
    } catch (err) {
      this.log.error("failed to spawn rebase-resolver for dag node", {
        dagId,
        nodeId,
        err: (err as Error).message,
      });
    }
  }
}
