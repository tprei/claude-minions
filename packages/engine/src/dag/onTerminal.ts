import type { Session } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { DagRepo } from "./model.js";
import type { Logger } from "../logger.js";
import type { DagScheduler } from "./scheduler.js";
import { AutomationJobRepo } from "../store/repos/automationJobRepo.js";
import { enqueueVerifyChild } from "../automation/handlers/verifyChild.js";

const DEFAULT_CI_SELF_HEAL_MAX_ATTEMPTS = 3;

function readSelfHealMaxAttempts(ctx: EngineContext): number {
  const raw = ctx.runtime.effective()["ciSelfHealMaxAttempts"];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_CI_SELF_HEAL_MAX_ATTEMPTS;
  }
  return Math.floor(raw);
}

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

    if (session.status === "cancelled") {
      this.repo.updateNode(node.id, {
        status: "cancelled",
        failedReason: null,
        completedAt: new Date().toISOString(),
      });
      await this.scheduler.tick(dag.id);
      return;
    }

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
      await this.scheduler.tick(dag.id);
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
      await this.scheduler.tick(dag.id);
      return;
    }

    try {
      const pr = await this.ctx.landing.openForReview(session.slug);
      const fresh = this.ctx.sessions.get(session.slug);
      const concluded = fresh?.metadata["ciSelfHealConcluded"];
      const maxAttempts = readSelfHealMaxAttempts(this.ctx);

      if (!pr || concluded === "success" || maxAttempts === 0) {
        this.repo.updateNode(node.id, {
          status: "pr-open",
          completedAt: new Date().toISOString(),
          failedReason: null,
        });
        this.log.info("dag node pr-open", { dagId: dag.id, nodeId: node.id, sessionSlug: session.slug });
        if (pr) this.enqueueVerifierSafe(session.slug);
        await this.scheduler.tick(dag.id);
        await this.maybeReleaseShipParent(dag.id);
        return;
      }

      if (concluded === "exhausted") {
        this.repo.updateNode(node.id, {
          status: "ci-failed",
          failedReason: "self-heal exhausted",
          completedAt: new Date().toISOString(),
        });
        this.raiseCiFailed(dag.rootSessionSlug ?? session.slug, node.id);
        await this.scheduler.tick(dag.id);
        return;
      }

      this.repo.updateNode(node.id, {
        status: "ci-pending",
        failedReason: null,
      });

      const alreadySelfHealing = fresh?.metadata["selfHealCi"] === true;
      if (!alreadySelfHealing) {
        this.ctx.sessions.setMetadata(session.slug, {
          selfHealCi: true,
          ciSelfHealAttempts: 0,
        });
      }
      const hasCiPending = (fresh?.attention ?? []).some((a) => a.kind === "ci_pending");
      if (!hasCiPending) {
        this.ctx.sessions.appendAttention(session.slug, {
          kind: "ci_pending",
          message: "Waiting for CI to complete on the dag-task PR",
          raisedAt: new Date().toISOString(),
        });
      }
      this.ctx.sessions.markWaitingInput(
        session.slug,
        "ci self-heal: parking until CI reports terminal state",
      );

      this.log.info("dag node entered ci-pending", {
        dagId: dag.id,
        nodeId: node.id,
        sessionSlug: session.slug,
        prNumber: pr.number,
      });
      await this.scheduler.tick(dag.id);
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
      await this.scheduler.tick(dag.id);
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

  private enqueueVerifierSafe(sessionSlug: string): void {
    try {
      const repo = new AutomationJobRepo(this.ctx.db);
      enqueueVerifyChild(repo, sessionSlug);
    } catch (err) {
      this.log.warn("enqueueVerifyChild failed", {
        slug: sessionSlug,
        err: (err as Error).message,
      });
    }
  }

  private raiseCiFailed(parentSlug: string, nodeId: string): void {
    if (!this.ctx.sessions.get(parentSlug)) return;
    this.ctx.sessions.appendAttention(parentSlug, {
      kind: "ci_failed",
      message: `DAG node ${nodeId} failed quality checks`,
      raisedAt: new Date().toISOString(),
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
