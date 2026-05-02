import type { DAG, DAGNode, SessionStatus } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { DagRepo } from "./model.js";
import type { Logger } from "../logger.js";
import type { AutomationJobRepo } from "../store/repos/automationJobRepo.js";
import { enqueueDagTick } from "../automation/handlers/dagTick.js";
import { isEngineError, EngineError } from "../errors.js";

const DEFAULT_MAX_CONCURRENT = 3;
const ADMISSION_RETRY_DELAY_MS = 30_000;
const MAX_ADMISSION_RETRIES = 60;

const STALE_READY_THRESHOLD_MS = 60_000;

const TERMINAL_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export const SUCCESS_NODE_STATUSES: ReadonlySet<DAGNode["status"]> = new Set<DAGNode["status"]>([
  "done",
  "pr-open",
  "merged",
  "landed",
  "skipped",
]);

const FAILED_NODE_STATUSES: ReadonlySet<DAGNode["status"]> = new Set<DAGNode["status"]>([
  "failed",
  "ci-failed",
  "rebase-conflict",
  "cancelled",
]);

const TERMINAL_NODE_STATUSES: ReadonlySet<DAGNode["status"]> = new Set<DAGNode["status"]>([
  ...SUCCESS_NODE_STATUSES,
  ...FAILED_NODE_STATUSES,
]);

function isAdmissionDenied(err: unknown): boolean {
  if (!isEngineError(err)) return false;
  if (err.code !== "conflict") return false;
  return err.message.startsWith("Admission denied:");
}

export class DagScheduler {
  private readonly staleReadyFirstSeen = new Map<string, number>();

  constructor(
    private readonly repo: DagRepo,
    private readonly ctx: EngineContext,
    private readonly log: Logger,
    private readonly automationRepo: AutomationJobRepo,
  ) {
    if (!automationRepo) {
      throw new EngineError("internal", "automation runner missing — DagScheduler requires automationRepo");
    }
  }

  async tick(dagId?: string): Promise<void> {
    const dags = dagId
      ? [this.repo.get(dagId)].filter((d): d is NonNullable<typeof d> => d !== null)
      : this.repo.list().filter((d) => d.status === "active" || d.status === "failed");

    for (const dag of dags) {
      this.recomputeDagStatus(dag.id);
      const refreshed = this.repo.get(dag.id);
      if (!refreshed || refreshed.status !== "active") continue;
      await this.tickDag(dag.id);
    }
  }

  recomputeDagStatus(dagId: string): void {
    const dag = this.repo.get(dagId);
    if (!dag) return;
    if (dag.status === "cancelled") return;
    if (dag.nodes.length === 0) return;

    const allSuccess = dag.nodes.every((n) => SUCCESS_NODE_STATUSES.has(n.status));
    if (allSuccess) {
      if (dag.status !== "completed") this.repo.update(dagId, { status: "completed" });
      return;
    }

    const allTerminal = dag.nodes.every((n) => TERMINAL_NODE_STATUSES.has(n.status));
    const anyFailed = dag.nodes.some((n) => FAILED_NODE_STATUSES.has(n.status));
    if (allTerminal && anyFailed) {
      if (dag.status !== "failed") this.repo.update(dagId, { status: "failed" });
      return;
    }

    if (dag.status !== "active") this.repo.update(dagId, { status: "active" });
  }

  private async tickDag(dagId: string): Promise<void> {
    const dag = this.repo.get(dagId);
    if (!dag) return;

    this.cascadeUpstreamFailures(dagId);

    const refreshed = this.repo.get(dagId);
    if (!refreshed) return;

    const maxConcurrent = this.resolveMaxConcurrent();

    const runningCount = refreshed.nodes.filter(
      (n) => n.status === "running" || n.status === "ready" || n.status === "ci-pending",
    ).length;

    if (runningCount >= maxConcurrent) return;

    const doneIds = new Set(
      refreshed.nodes.filter((n) => SUCCESS_NODE_STATUSES.has(n.status)).map((n) => n.id),
    );

    const pending = refreshed.nodes.filter((n) => n.status === "pending");

    let spawned = runningCount;
    for (const node of pending) {
      if (spawned >= maxConcurrent) break;
      const depsAllDone = node.dependsOn.every((depId) => doneIds.has(depId));
      if (!depsAllDone) continue;

      await this.spawnNodeSession(dag.id, node);
      spawned++;
    }

    this.recomputeDagStatus(dagId);
  }

  private cascadeUpstreamFailures(dagId: string): void {
    let anyChanged = false;
    while (true) {
      const dag = this.repo.get(dagId);
      if (!dag) return;
      const failedIds = new Set(
        dag.nodes.filter((n) => FAILED_NODE_STATUSES.has(n.status)).map((n) => n.id),
      );
      if (failedIds.size === 0) break;

      let passChanged = false;
      for (const node of dag.nodes) {
        if (node.status !== "pending") continue;
        const blockedBy = node.dependsOn.find((d) => failedIds.has(d));
        if (!blockedBy) continue;
        this.repo.updateNode(node.id, {
          status: "cancelled",
          failedReason: `upstream node ${blockedBy} failed`,
          completedAt: new Date().toISOString(),
        });
        passChanged = true;
        this.log.info("dag node cancelled due to upstream failure", {
          dagId,
          nodeId: node.id,
          upstream: blockedBy,
        });
      }
      if (!passChanged) break;
      anyChanged = true;
    }
    if (anyChanged) this.recomputeDagStatus(dagId);
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

      this.ctx.sessions.setDagId(session.slug, dagId);

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
      if (isAdmissionDenied(err)) {
        this.handleAdmissionDenied(dagId, node, err);
        return;
      }
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

  private handleAdmissionDenied(dagId: string, node: DAGNode, err: unknown): void {
    const previous =
      typeof node.metadata.admissionRetries === "number" ? node.metadata.admissionRetries : 0;
    const retries = previous + 1;
    const message = (err as Error).message;

    if (retries >= MAX_ADMISSION_RETRIES) {
      this.repo.updateNode(node.id, {
        status: "failed",
        failedReason: `admission denied ${retries} times — slot pressure too high`,
        metadata: { ...node.metadata, admissionRetries: retries },
      });
      this.log.error("dag node admission retries exhausted", {
        dagId,
        nodeId: node.id,
        retries,
        lastReason: message,
      });
      return;
    }

    this.repo.updateNode(node.id, {
      status: "pending",
      metadata: { ...node.metadata, admissionRetries: retries },
    });
    this.log.warn("dag node admission denied, deferring spawn", {
      dagId,
      nodeId: node.id,
      retries,
      reason: message,
    });

    enqueueDagTick(this.automationRepo, dagId, ADMISSION_RETRY_DELAY_MS);
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

  private resolveMaxConcurrent(): number {
    const overrides = this.ctx.runtime.values();
    const override = overrides["dagMaxConcurrent"];
    if (typeof override === "number" && override > 0) return override;
    return DEFAULT_MAX_CONCURRENT;
  }

  /**
   * Runs on a 30s interval. Flips running nodes to failed when their session has
   * terminated, and re-dispatches DAGs that have nodes stuck in ready >60s with
   * no session (absorbs the sidecar dagStaleReady rule for unattended Docker).
   */
  async watchdogTick(): Promise<void> {
    const dags = this.repo.list().filter((d) => d.status === "active");
    const liveStaleKeys = new Set<string>();

    for (const dag of dags) {
      let mutated = false;
      let hasStaleReady = false;

      for (const node of dag.nodes) {
        if (node.status === "running") {
          if (!node.sessionSlug) continue;
          const session = this.ctx.sessions.get(node.sessionSlug);
          if (!session) continue;
          if (!TERMINAL_SESSION_STATUSES.has(session.status)) continue;
          // Only flip to failed when the session terminated unhappily.
          // "completed" is the happy-path turn_completed event — the
          // completion handlers (qualityGate → onTerminal) advance the
          // node to ci-pending or pr-open within milliseconds. Flipping it
          // to "failed" here races those handlers and triggers
          // cascadeUpstreamFailures to nuke every dependent before the
          // normal flow gets a chance to run.
          if (session.status !== "failed" && session.status !== "cancelled") {
            continue;
          }
          const from = node.status;
          this.repo.updateNode(node.id, {
            status: "failed",
            failedReason: `watchdog: session ${node.sessionSlug} terminated as ${session.status}`,
            completedAt: new Date().toISOString(),
          });
          mutated = true;
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
        } else if (node.status === "ready" && !node.sessionSlug) {
          const key = `${dag.id}:${node.id}`;
          liveStaleKeys.add(key);
          const seen = this.staleReadyFirstSeen.get(key);
          if (!seen) {
            this.staleReadyFirstSeen.set(key, Date.now());
          } else if (Date.now() - seen >= STALE_READY_THRESHOLD_MS) {
            hasStaleReady = true;
          }
        }
      }

      if (mutated) this.recomputeDagStatus(dag.id);

      if (hasStaleReady) {
        this.log.warn("dag watchdog: re-dispatching stale-ready dag", { dagId: dag.id });
        await this.tick(dag.id);
      }
    }

    for (const k of [...this.staleReadyFirstSeen.keys()]) {
      if (!liveStaleKeys.has(k)) {
        this.staleReadyFirstSeen.delete(k);
      }
    }
  }
}
