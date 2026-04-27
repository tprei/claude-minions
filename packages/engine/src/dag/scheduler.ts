import type { DAGNode } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { DagRepo } from "./model.js";
import type { Logger } from "../logger.js";

const DEFAULT_MAX_CONCURRENT = 3;

export class DagScheduler {
  constructor(
    private readonly repo: DagRepo,
    private readonly ctx: EngineContext,
    private readonly log: Logger,
  ) {}

  async tick(dagId?: string): Promise<void> {
    const dags = dagId
      ? [this.repo.get(dagId)].filter((d): d is NonNullable<typeof d> => d !== null)
      : this.repo.list().filter((d) => d.status === "active");

    for (const dag of dags) {
      if (dag.status !== "active") continue;
      await this.tickDag(dag.id);
    }
  }

  private async tickDag(dagId: string): Promise<void> {
    const dag = this.repo.get(dagId);
    if (!dag) return;

    const maxConcurrent = this.resolveMaxConcurrent();

    const runningCount = dag.nodes.filter(
      (n) => n.status === "running" || n.status === "ready",
    ).length;

    if (runningCount >= maxConcurrent) return;

    const doneStatuses = new Set<DAGNode["status"]>(["done", "landed"]);
    const doneIds = new Set(dag.nodes.filter((n) => doneStatuses.has(n.status)).map((n) => n.id));

    const pending = dag.nodes.filter((n) => n.status === "pending");

    let spawned = runningCount;
    for (const node of pending) {
      if (spawned >= maxConcurrent) break;
      const depsAllDone = node.dependsOn.every((depId) => doneIds.has(depId));
      if (!depsAllDone) continue;

      await this.spawnNodeSession(dag.id, node);
      spawned++;
    }

    this.checkCompletion(dagId);
  }

  private async spawnNodeSession(dagId: string, node: DAGNode): Promise<void> {
    const dag = this.repo.get(dagId);
    if (!dag) return;

    this.repo.updateNode(node.id, { status: "ready" });

    try {
      const session = await this.ctx.sessions.create({
        prompt: node.prompt,
        mode: "dag-task",
        title: node.title,
        repoId: dag.repoId,
        baseBranch: dag.baseBranch,
        metadata: { dagId, dagNodeId: node.id },
      });

      this.repo.updateNode(node.id, {
        status: "running",
        sessionSlug: session.slug,
        startedAt: new Date().toISOString(),
      });

      this.log.info("dag node session spawned", {
        dagId,
        nodeId: node.id,
        sessionSlug: session.slug,
      });
    } catch (err) {
      this.repo.updateNode(node.id, {
        status: "failed",
        failedReason: (err as Error).message,
      });
      this.log.error("failed to spawn dag node session", {
        dagId,
        nodeId: node.id,
        err: (err as Error).message,
      });
    }
  }

  private checkCompletion(dagId: string): void {
    const dag = this.repo.get(dagId);
    if (!dag) return;

    const allTerminal = dag.nodes.every((n) =>
      ["done", "landed", "failed", "skipped"].includes(n.status),
    );
    if (!allTerminal) return;

    const anyFailed = dag.nodes.some((n) => n.status === "failed");
    this.repo.update(dagId, { status: anyFailed ? "failed" : "completed" });
  }

  private resolveMaxConcurrent(): number {
    const overrides = this.ctx.runtime.values();
    const override = overrides["dagMaxConcurrent"];
    if (typeof override === "number" && override > 0) return override;
    return DEFAULT_MAX_CONCURRENT;
  }
}
