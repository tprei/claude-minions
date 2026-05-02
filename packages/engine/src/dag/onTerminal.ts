import type { Session } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { DagRepo } from "./model.js";
import type { Logger } from "../logger.js";
import type { DagScheduler } from "./scheduler.js";
import { AutomationJobRepo } from "../store/repos/automationJobRepo.js";
import { enqueueVerifyChild } from "../automation/handlers/verifyChild.js";
import { enqueueDagTick } from "../automation/handlers/dagTick.js";
import { isEngineError } from "../errors.js";

const DEFAULT_CI_SELF_HEAL_MAX_ATTEMPTS = 3;
const TRANSIENT_PUSH_RETRY_DELAY_MS = 60_000;
const QUALITY_SELF_HEAL_MAX_ATTEMPTS = 2;

function readSelfHealMaxAttempts(ctx: EngineContext): number {
  const raw = ctx.runtime.effective()["ciSelfHealMaxAttempts"];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_CI_SELF_HEAL_MAX_ATTEMPTS;
  }
  return Math.floor(raw);
}

function readQualitySelfHealAttempts(metadata: Record<string, unknown>): number {
  const raw = metadata["qualitySelfHealAttempts"];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

function formatQualityFailureForAgent(
  report: import("@minions/shared").QualityReport,
): string {
  const failed = report.checks.filter((c) => c.status === "failed");
  if (failed.length === 0) {
    return `The local quality gate reported status \`${report.status}\` but no specific checks failed. Re-run \`pnpm run check\` (or whatever the workspace's quality runner is) and address what it reports.`;
  }
  const lines: string[] = [
    "Your local quality gate failed before the engine could open a PR. Fix the underlying issues and push another commit. Do not bypass hooks or skip checks.",
    "",
  ];
  for (const c of failed) {
    lines.push(`### Check failed: \`${c.name}\` (\`${c.command}\`, exit ${c.exitCode ?? "?"})`);
    if (c.stdoutTail) {
      lines.push("stdout (tail):");
      lines.push("```");
      lines.push(c.stdoutTail.slice(-1500));
      lines.push("```");
    }
    if (c.stderrTail) {
      lines.push("stderr (tail):");
      lines.push("```");
      lines.push(c.stderrTail.slice(-1500));
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

export class DagTerminalHandler {
  constructor(
    private readonly repo: DagRepo,
    private readonly scheduler: DagScheduler,
    private readonly ctx: EngineContext,
    private readonly log: Logger,
    private readonly automationRepo?: AutomationJobRepo,
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
      const attempts = readQualitySelfHealAttempts(session.metadata);
      if (attempts >= QUALITY_SELF_HEAL_MAX_ATTEMPTS) {
        this.repo.updateNode(node.id, {
          status: "ci-failed",
          failedReason: `quality gate ${qualityReport.status} after ${attempts} self-heal attempts`,
          completedAt: new Date().toISOString(),
        });
        this.raiseCiFailed(dag.rootSessionSlug ?? session.slug, node.id);
        this.log.warn("dag node quality self-heal exhausted", {
          dagId: dag.id,
          nodeId: node.id,
          sessionSlug: session.slug,
          attempts,
        });
        await this.scheduler.tick(dag.id);
        return;
      }

      // Self-heal: ask the same agent to fix the local quality failure and
      // push another commit. Mirrors how CI failures on an open PR get
      // auto-fixed; the difference is that quality runs BEFORE the PR is
      // opened, so we keep the node in "running" and re-queue the agent
      // instead of routing through the post-PR ciFailureFix flow.
      const nextAttempt = attempts + 1;
      this.ctx.sessions.setMetadata(session.slug, {
        qualitySelfHealAttempts: nextAttempt,
      });
      try {
        await this.ctx.sessions.reply(
          session.slug,
          formatQualityFailureForAgent(qualityReport),
        );
        await this.ctx.sessions.kickReplyQueue(session.slug);
      } catch (err) {
        this.log.warn("quality self-heal reply failed; marking node ci-failed", {
          dagId: dag.id,
          nodeId: node.id,
          err: (err as Error).message,
        });
        this.repo.updateNode(node.id, {
          status: "ci-failed",
          failedReason: `quality gate ${qualityReport.status}; reply failed: ${(err as Error).message}`,
          completedAt: new Date().toISOString(),
        });
        this.raiseCiFailed(dag.rootSessionSlug ?? session.slug, node.id);
        await this.scheduler.tick(dag.id);
        return;
      }

      this.repo.updateNode(node.id, {
        status: "running",
        failedReason: null,
      });
      this.ctx.audit.record(
        "system",
        "dag.node.quality_self_heal",
        { kind: "dag", id: dag.id },
        {
          nodeId: node.id,
          sessionSlug: session.slug,
          attempt: nextAttempt,
          maxAttempts: QUALITY_SELF_HEAL_MAX_ATTEMPTS,
        },
      );
      this.log.info("dag node quality self-heal: queued reply for agent", {
        dagId: dag.id,
        nodeId: node.id,
        sessionSlug: session.slug,
        attempt: nextAttempt,
      });
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
      if (
        isEngineError(err) &&
        (err.code === "transient_push_error" || err.code === "transient_github_error")
      ) {
        const retryAfterMs =
          err.code === "transient_github_error" && typeof err.detail?.["retryAfterMs"] === "number"
            ? Math.max(TRANSIENT_PUSH_RETRY_DELAY_MS, err.detail["retryAfterMs"] as number)
            : TRANSIENT_PUSH_RETRY_DELAY_MS;
        this.log.warn("dag node landing hit transient error; will retry", {
          dagId: dag.id,
          nodeId: node.id,
          code: err.code,
          retryAfterMs,
          err: message,
        });
        this.ctx.audit.record(
          "system",
          err.code === "transient_github_error"
            ? "dag.node.transient_github_retry"
            : "dag.node.transient_push_retry",
          { kind: "dag", id: dag.id },
          { nodeId: node.id, sessionSlug: session.slug, error: message },
        );
        if (this.automationRepo) {
          enqueueDagTick(this.automationRepo, dag.id, retryAfterMs);
        } else {
          await this.scheduler.tick(dag.id);
        }
        return;
      }
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
