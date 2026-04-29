import type { Session } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { DagRepo } from "./model.js";
import type { Logger } from "../logger.js";
import type { DagScheduler } from "./scheduler.js";

export class DagTerminalHandler {
  constructor(
    private readonly repo: DagRepo,
    private readonly scheduler: DagScheduler,
    private readonly ctx: EngineContext,
    private readonly log: Logger,
  ) {}

  async handle(session: Session): Promise<void> {
    if (session.mode !== "dag-task") return;

    const node = this.repo.getNodeBySession(session.slug);
    if (!node) return;

    const dag = this.repo.byNodeSession(session.slug);
    if (!dag) return;

    if (session.status !== "completed") {
      this.repo.updateNode(node.id, {
        status: "failed",
        failedReason: `session terminated with status: ${session.status}`,
        completedAt: new Date().toISOString(),
      });
      await this.scheduler.tick(dag.id);
      return;
    }

    const qualityReport = this.ctx.quality.getReport(session.slug);
    if (qualityReport === null) {
      this.repo.updateNode(node.id, {
        status: "ci-failed",
        failedReason: "quality report missing",
        completedAt: new Date().toISOString(),
      });
      this.raiseCiFailed(dag.rootSessionSlug ?? session.slug, node.id);
      return;
    }

    const qualityPassed =
      qualityReport.status === "passed" || qualityReport.status === "partial";

    if (!qualityPassed) {
      this.repo.updateNode(node.id, {
        status: "ci-failed",
        failedReason: `quality gate ${qualityReport.status}`,
        completedAt: new Date().toISOString(),
      });
      this.raiseCiFailed(dag.rootSessionSlug ?? session.slug, node.id);
      return;
    }

    try {
      await this.ctx.landing.land(session.slug, "squash", false);
      this.repo.updateNode(node.id, {
        status: "landed",
        completedAt: new Date().toISOString(),
      });
      this.log.info("dag node landed", { dagId: dag.id, nodeId: node.id, sessionSlug: session.slug });
      await this.scheduler.tick(dag.id);
      await this.maybeReleaseShipParent(dag.id);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("rebase") || message.includes("conflict")) {
        this.repo.updateNode(node.id, {
          status: "rebase-conflict",
          failedReason: message,
        });
        await this.spawnRebaseResolver(session.slug, dag.id, node.id, message);
      } else {
        this.repo.updateNode(node.id, {
          status: "failed",
          failedReason: message,
          completedAt: new Date().toISOString(),
        });
        this.log.error("dag node landing failed", {
          dagId: dag.id,
          nodeId: node.id,
          err: message,
        });
      }
    }
  }

  private async maybeReleaseShipParent(dagId: string): Promise<void> {
    try {
      const refreshed = this.repo.get(dagId);
      if (!refreshed) return;
      if (refreshed.status !== "completed") return;
      const rootSlug = refreshed.rootSessionSlug;
      if (!rootSlug) return;
      const parent = this.ctx.sessions.get(rootSlug);
      if (!parent || parent.mode !== "ship" || parent.shipStage !== "dag") return;
      await this.ctx.ship.advance(rootSlug, "verify");
      await this.ctx.sessions.kickReplyQueue(rootSlug);
    } catch (err) {
      this.log.error("failed to release ship parent after dag completion", {
        dagId,
        err: (err as Error).message,
      });
    }
  }

  private raiseCiFailed(parentSlug: string, nodeId: string): void {
    const parent = this.ctx.sessions.get(parentSlug);
    if (!parent) return;
    const flags = [
      ...parent.attention,
      {
        kind: "ci_failed" as const,
        message: `DAG node ${nodeId} failed quality checks`,
        raisedAt: new Date().toISOString(),
      },
    ];
    this.ctx.bus.emit({
      kind: "session_updated",
      session: { ...parent, attention: flags },
    });
  }

  private async spawnRebaseResolver(
    conflictSessionSlug: string,
    dagId: string,
    nodeId: string,
    conflictMessage: string,
  ): Promise<void> {
    const conflictSession = this.ctx.sessions.get(conflictSessionSlug);
    if (!conflictSession) return;

    const prompt =
      `A rebase conflict occurred while landing a DAG task.\n\n` +
      `Session: ${conflictSessionSlug}\n` +
      `DAG: ${dagId}\n` +
      `Node: ${nodeId}\n` +
      `Error: ${conflictMessage}\n\n` +
      `Please resolve the conflict markers in the worktree at: ${conflictSession.worktreePath ?? "unknown"}.\n` +
      `Look for files containing <<<<<<, =======, and >>>>>>> markers and resolve them.\n` +
      `After resolving, complete the rebase with \`git rebase --continue\`.`;

    try {
      await this.ctx.sessions.create({
        prompt,
        mode: "rebase-resolver",
        title: `Rebase resolver for node ${nodeId}`,
        repoId: conflictSession.repoId,
        baseBranch: conflictSession.baseBranch,
        parentSlug: conflictSessionSlug,
        metadata: { dagId, dagNodeId: nodeId },
      });
      this.log.info("spawned rebase-resolver session", { dagId, nodeId, conflictSessionSlug });
    } catch (err) {
      this.log.error("failed to spawn rebase-resolver", {
        dagId,
        nodeId,
        err: (err as Error).message,
      });
    }
  }
}
