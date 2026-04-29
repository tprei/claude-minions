import type { DAG, DAGNode, SessionStatus } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { DagRepo } from "./model.js";
import type { Logger } from "../logger.js";

const DEFAULT_MAX_CONCURRENT = 3;

const TERMINAL_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const TERMINAL_NODE_STATUSES: ReadonlySet<DAGNode["status"]> = new Set<DAGNode["status"]>([
  "done",
  "landed",
  "skipped",
  "failed",
  "ci-failed",
  "rebase-conflict",
  "cancelled",
]);

const FAILED_NODE_STATUSES: ReadonlySet<DAGNode["status"]> = new Set<DAGNode["status"]>([
  "failed",
  "ci-failed",
  "rebase-conflict",
  "cancelled",
]);

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

    const baseBranch = this.resolveNodeBaseBranch(dag, node);

    try {
      const session = await this.ctx.sessions.create({
        prompt: node.prompt,
        mode: "dag-task",
        title: node.title,
        repoId: dag.repoId,
        baseBranch,
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

  private resolveNodeBaseBranch(dag: DAG, node: DAGNode): string | undefined {
    if (node.dependsOn.length === 0) {
      return dag.baseBranch;
    }
    const firstDepId = node.dependsOn[0];
    if (!firstDepId) return dag.baseBranch;
    const depNode = this.repo.getNode(firstDepId);
    if (!depNode || !depNode.sessionSlug) {
      this.log.warn("dag dep node has no session yet, falling back to dag base branch", {
        dagId: dag.id,
        nodeId: node.id,
        depNodeId: firstDepId,
      });
      return dag.baseBranch;
    }
    const depSession = this.ctx.sessions.get(depNode.sessionSlug);
    if (!depSession || !depSession.branch) {
      this.log.warn("dag dep session has no branch, falling back to dag base branch", {
        dagId: dag.id,
        nodeId: node.id,
        depNodeId: firstDepId,
        depSessionSlug: depNode.sessionSlug,
      });
      return dag.baseBranch;
    }
    return depSession.branch;
  }

  private checkCompletion(dagId: string): void {
    const dag = this.repo.get(dagId);
    if (!dag) return;

    const allTerminal = dag.nodes.every((n) => TERMINAL_NODE_STATUSES.has(n.status));
    if (!allTerminal) return;

    const anyFailed = dag.nodes.some((n) => FAILED_NODE_STATUSES.has(n.status));
    this.repo.update(dagId, { status: anyFailed ? "failed" : "completed" });
  }

  private resolveMaxConcurrent(): number {
    const overrides = this.ctx.runtime.values();
    const override = overrides["dagMaxConcurrent"];
    if (typeof override === "number" && override > 0) return override;
    return DEFAULT_MAX_CONCURRENT;
  }

  // TODO: extract to sidecar
  async watchdogTick(): Promise<void> {
    const dags = this.repo.list().filter((d) => d.status === "active");
    for (const dag of dags) {
      for (const node of dag.nodes) {
        if (node.status !== "running") continue;
        if (!node.sessionSlug) continue;
        const session = this.ctx.sessions.get(node.sessionSlug);
        if (!session) continue;
        if (!TERMINAL_SESSION_STATUSES.has(session.status)) continue;
        const from = node.status;
        this.repo.updateNode(node.id, {
          status: "failed",
          failedReason: `watchdog: session ${node.sessionSlug} terminated as ${session.status}`,
          completedAt: new Date().toISOString(),
        });
        this.ctx.audit.record(
          "system",
          "dag.watchdog",
          { kind: "dag", id: dag.id },
          { nodeId: node.id, from, to: "failed", sessionStatus: session.status },
        );
        this.log.warn("dag watchdog flipped node to failed", {
          dagId: dag.id,
          nodeId: node.id,
          sessionSlug: node.sessionSlug,
          sessionStatus: session.status,
        });
      }
    }
  }
}
