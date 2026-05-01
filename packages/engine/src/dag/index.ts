import { isRetryableDagNodeStatus } from "@minions/shared";
import type { DAG, DAGNodeStatus, DAGSplitRequest, StatusEvent } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import type { AutomationJobRepo } from "../store/repos/automationJobRepo.js";
import { DagRepo } from "./model.js";
import { DagScheduler, SUCCESS_NODE_STATUSES } from "./scheduler.js";
import { DagTerminalHandler } from "./onTerminal.js";
import { DagMergedHandler } from "./onMerged.js";
import { registerDagRoutes } from "./routes.js";
import { parseDagFromTranscript, extractDagBlocks } from "./parser.js";
import { newSlug, newEventId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { EngineError } from "../errors.js";

const DAG_FENCE_DETECT_RE = /```dag\s*\n([\s\S]*?)```/g;

function reconcileStaleRunningNodes(
  db: import("better-sqlite3").Database,
  repo: DagRepo,
  ctx: EngineContext,
  log: Logger,
): string[] {
  const stmtClearSlug = db.prepare(
    `UPDATE dag_nodes SET status = ?, session_slug = NULL WHERE id = ?`,
  );
  const dags = repo.list().filter((d) => d.status === "active");
  const dagIds: string[] = [];
  for (const dag of dags) {
    try {
      for (const node of dag.nodes) {
        if (node.status !== "running") continue;
        const sessionSlug = node.sessionSlug;
        const session = sessionSlug ? ctx.sessions.get(sessionSlug) : null;
        const sessionAlive =
          session !== null &&
          (session.status === "running" ||
            session.status === "pending" ||
            session.status === "waiting_input");
        if (!sessionAlive) {
          stmtClearSlug.run("pending", node.id);
          ctx.audit.record(
            "system",
            "dag.boot-reconcile",
            { kind: "dag", id: dag.id },
            { nodeId: node.id, from: "running", to: "pending", sessionSlug: sessionSlug ?? null },
          );
          log.info("dag boot reconcile reset stale running node", {
            dagId: dag.id,
            nodeId: node.id,
            sessionSlug: sessionSlug ?? null,
          });
        }
      }
      dagIds.push(dag.id);
    } catch (err) {
      log.error("dag boot reconcile failed for dag", { dagId: dag.id, err: (err as Error).message });
      ctx.audit.record(
        "system",
        "dag.boot-reconcile.failed",
        { kind: "dag", id: dag.id },
        { error: (err as Error).message },
      );
    }
  }
  return dagIds;
}

export async function dispatchAfterBootReconcile(
  scheduler: DagScheduler,
  dagIds: string[],
  ctx: EngineContext,
  log: Logger,
): Promise<void> {
  for (const dagId of dagIds) {
    try {
      await scheduler.tick(dagId);
    } catch (err) {
      log.error("dag boot reconcile tick failed", { dagId, err: (err as Error).message });
      ctx.audit.record(
        "system",
        "dag.boot-reconcile.failed",
        { kind: "dag", id: dagId },
        { error: (err as Error).message, phase: "tick" },
      );
    }
  }
}

export function createDagSubsystem(
  deps: SubsystemDeps & { automationRepo: AutomationJobRepo },
): SubsystemResult<EngineContext["dags"]> {
  const { ctx, db, bus, log, automationRepo } = deps;

  const repo = new DagRepo(db, bus);
  const scheduler = new DagScheduler(
    repo,
    ctx,
    log.child({ subsystem: "dag-scheduler" }),
    automationRepo,
  );
  const terminalHandler = new DagTerminalHandler(
    repo,
    scheduler,
    ctx,
    log.child({ subsystem: "dag-terminal" }),
  );
  const mergedHandler = new DagMergedHandler(
    repo,
    scheduler,
    ctx,
    log.child({ subsystem: "dag-merged" }),
  );

  const reconciledIds = reconcileStaleRunningNodes(db, repo, ctx, log);
  // Tick every active DAG after stale-node reconciliation so pending nodes
  // resume promptly after a restart. Operator triggers (retry/cancel) still
  // call tick() directly.
  void dispatchAfterBootReconcile(scheduler, reconciledIds, ctx, log);

  const subLog = log.child({ subsystem: "dag-parser-sub" });
  const warnedBlocksBySlug = new Map<string, Set<string>>();

  const insertStatusStmt = db.prepare(
    `INSERT INTO transcript_events(id, session_slug, seq, turn, kind, body, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const maxSeqStmt = db.prepare(
    `SELECT COALESCE(MAX(seq), -1) as max_seq FROM transcript_events WHERE session_slug = ?`,
  );
  const countStmt = db.prepare(
    `SELECT COUNT(*) as cnt FROM transcript_events WHERE session_slug = ?`,
  );

  function emitStatus(slug: string, level: "info" | "warn", text: string, data?: Record<string, unknown>): void {
    const seqRow = maxSeqStmt.get(slug) as { max_seq: number } | undefined;
    const seq = (seqRow?.max_seq ?? -1) + 1;
    const countRow = countStmt.get(slug) as { cnt: number } | undefined;
    const turn = countRow?.cnt ?? 0;
    const event: StatusEvent = {
      id: newEventId(),
      sessionSlug: slug,
      seq,
      turn,
      timestamp: nowIso(),
      kind: "status",
      level,
      text,
      ...(data ? { data } : {}),
    };
    insertStatusStmt.run(
      event.id,
      slug,
      seq,
      turn,
      event.kind,
      JSON.stringify(event),
      event.timestamp,
    );
    bus.emit({ kind: "transcript_event", sessionSlug: slug, event });
  }

  function findFencedDagBlocks(events: ReadonlyArray<import("@minions/shared").TranscriptEvent>): string[] {
    const blocks: string[] = [];
    for (const ev of events) {
      if (ev.kind !== "assistant_text") continue;
      for (const body of extractDagBlocks(ev.text)) {
        blocks.push(body.trim());
      }
    }
    return blocks;
  }

  async function tryCreateFromTranscript(
    slug: string,
  ): Promise<{ created: boolean; dagId?: string }> {
    const session = ctx.sessions.get(slug);
    if (!session) return { created: false };

    const existing = repo.byRootSession(slug);
    if (existing) return { created: false, dagId: existing.id };

    const transcript = ctx.sessions.transcript(slug);
    const parsed = parseDagFromTranscript(transcript);
    if (!parsed) return { created: false };

    try {
      const created = repo.createFromParsed(parsed, {
        repoId: session.repoId,
        baseBranch: session.baseBranch,
        rootSessionSlug: slug,
      });
      emitStatus(
        slug,
        "info",
        `Created DAG ${created.id} with ${created.nodes.length} nodes from your fenced JSON block.`,
        { dagId: created.id, nodeCount: created.nodes.length },
      );
      subLog.info("dag created from transcript", {
        slug,
        dagId: created.id,
        nodes: created.nodes.length,
      });
      ctx.sessions.setDagId(slug, created.id);
      await scheduler.tick(created.id);
      return { created: true, dagId: created.id };
    } catch (err) {
      subLog.error("failed to create dag from parsed transcript", {
        slug,
        err: (err as Error).message,
      });
      return { created: false };
    }
  }

  function emitMalformedBlockWarning(slug: string): void {
    const transcript = ctx.sessions.transcript(slug);
    const blocks = findFencedDagBlocks(transcript);
    if (blocks.length === 0) return;

    let warned = warnedBlocksBySlug.get(slug);
    if (!warned) {
      warned = new Set();
      warnedBlocksBySlug.set(slug, warned);
    }
    for (const block of blocks) {
      if (warned.has(block)) continue;
      warned.add(block);
      emitStatus(
        slug,
        "warn",
        `DAG block detected but failed to parse; please re-emit a valid JSON shape: {title, goal, nodes: [{title, prompt, dependsOn?}]}`,
      );
      break;
    }
  }

  const unsubscribe = bus.on("transcript_event", (event) => {
    const slug = event.sessionSlug;
    const session = ctx.sessions.get(slug);
    if (!session) return;
    if (session.mode !== "ship") return;
    if (session.shipStage !== "dag") return;

    tryCreateFromTranscript(slug)
      .then((result) => {
        if (result.created || result.dagId) return;
        emitMalformedBlockWarning(slug);
      })
      .catch((err: unknown) => {
        subLog.error("transcript_event tryCreateFromTranscript failed", {
          slug,
          err: (err as Error).message,
        });
      });
  });

  const api: EngineContext["dags"] = {
    list(): DAG[] {
      return repo.list();
    },

    get(id: string): DAG | null {
      return repo.get(id);
    },

    async splitNode(req: DAGSplitRequest): Promise<DAG> {
      const dag = repo.get(req.dagId);
      if (!dag) throw new EngineError("not_found", `dag not found: ${req.dagId}`);

      const original = repo.getNode(req.nodeId);
      if (!original) throw new EngineError("not_found", `dag node not found: ${req.nodeId}`);
      if (original.status !== "pending") {
        throw new EngineError("conflict", `can only split pending nodes, got: ${original.status}`);
      }

      const dependentsOfOriginal = dag.nodes
        .filter((n) => n.dependsOn.includes(req.nodeId))
        .map((n) => n.id);

      repo.deleteNode(req.nodeId);

      const newNodeIds: string[] = [];
      let ord = repo.nextOrd(req.dagId);
      for (const newNodeSpec of req.newNodes) {
        const inserted = repo.insertNode(
          req.dagId,
          {
            title: newNodeSpec.title,
            prompt: newNodeSpec.prompt,
            status: "pending",
            dependsOn: newNodeSpec.dependsOn,
            metadata: {},
          },
          ord++,
        );
        newNodeIds.push(inserted.id);
      }

      for (const depId of dependentsOfOriginal) {
        const depNode = repo.getNode(depId);
        if (!depNode) continue;
        const updatedDeps = depNode.dependsOn
          .filter((id) => id !== req.nodeId)
          .concat(newNodeIds);
        repo.updateNode(depId, { dependsOn: updatedDeps });
      }

      const updated = repo.get(req.dagId);
      if (!updated) throw new EngineError("internal", `dag not found after split: ${req.dagId}`);
      bus.emit({ kind: "dag_updated", dag: updated });
      await scheduler.tick(req.dagId);
      return updated;
    },

    async onSessionTerminal(sessionSlug: string): Promise<void> {
      const session = ctx.sessions.get(sessionSlug);
      if (!session) return;
      await terminalHandler.handle(session);
    },

    async onSessionPrMerged(sessionSlug: string): Promise<void> {
      await mergedHandler.handle(sessionSlug);
    },

    async onSessionCiTerminal(sessionSlug: string): Promise<void> {
      const node = repo.getNodeBySession(sessionSlug);
      if (!node) return;
      if (node.status !== "ci-pending") return;
      const dag = repo.byNodeSession(sessionSlug);
      if (!dag) return;

      const session = ctx.sessions.get(sessionSlug);
      const concluded = session?.metadata["ciSelfHealConcluded"];

      let outcome: "pr-open" | "ci-failed";
      if (concluded === "success") {
        repo.updateNode(node.id, {
          status: "pr-open",
          completedAt: new Date().toISOString(),
          failedReason: null,
        });
        outcome = "pr-open";
        ctx.audit.record(
          "system",
          "dag.node.ci-landed",
          { kind: "dag-node", id: node.id },
          { dagId: dag.id, sessionSlug },
        );
      } else if (concluded === "exhausted") {
        repo.updateNode(node.id, {
          status: "ci-failed",
          failedReason: "ci self-heal exhausted",
          completedAt: new Date().toISOString(),
        });
        outcome = "ci-failed";
        const parent = dag.rootSessionSlug
          ? ctx.sessions.get(dag.rootSessionSlug)
          : null;
        if (parent) {
          const flags = [
            ...parent.attention,
            {
              kind: "ci_failed" as const,
              message: `DAG node ${node.id} failed CI after self-heal retries`,
              raisedAt: new Date().toISOString(),
            },
          ];
          ctx.bus.emit({
            kind: "session_updated",
            session: { ...parent, attention: flags },
          });
        }
        ctx.audit.record(
          "system",
          "dag.node.ci-failed",
          { kind: "dag-node", id: node.id },
          { dagId: dag.id, sessionSlug },
        );
      } else {
        return;
      }

      await scheduler.tick(dag.id);

      if (outcome === "pr-open") {
        const refreshed = repo.get(dag.id);
        if (refreshed?.status === "completed" && refreshed.rootSessionSlug) {
          const parent = ctx.sessions.get(refreshed.rootSessionSlug);
          if (parent && parent.mode === "ship" && parent.shipStage === "dag") {
            try {
              await ctx.ship.advance(refreshed.rootSessionSlug, "verify");
              await ctx.sessions.kickReplyQueue(refreshed.rootSessionSlug);
            } catch (err) {
              log.error("failed to release ship parent after dag ci-landed", {
                dagId: refreshed.id,
                err: (err as Error).message,
              });
            }
          }
        }
      }
    },

    async retry(dagId: string, nodeId: string): Promise<void> {
      const dag = repo.get(dagId);
      if (!dag) throw new EngineError("not_found", `dag not found: ${dagId}`);
      const node = repo.getNode(nodeId);
      if (!node) throw new EngineError("not_found", `dag node not found: ${nodeId}`);
      if (dag.status === "cancelled") {
        throw new EngineError("conflict", `cannot retry node in cancelled dag: ${dagId}`);
      }
      if (!isRetryableDagNodeStatus(node.status)) {
        throw new EngineError("conflict", `node is not in a retryable status: ${node.status}`);
      }
      for (const depId of node.dependsOn) {
        const depNode = repo.getNode(depId);
        if (!depNode || !SUCCESS_NODE_STATUSES.has(depNode.status)) {
          const status = depNode?.status ?? "missing";
          throw new EngineError(
            "conflict",
            `upstream dep ${depId} is not landed/completed: ${status}`,
          );
        }
      }

      const from = node.status;
      const oldSessionSlug = node.sessionSlug;

      if (oldSessionSlug) {
        const old = ctx.sessions.get(oldSessionSlug);
        const terminal =
          old && (old.status === "completed" || old.status === "failed" || old.status === "cancelled");
        if (old && !terminal) {
          try {
            await ctx.sessions.stop(oldSessionSlug, "dag-node-retry");
          } catch (err) {
            log.warn("failed to stop zombie session for dag node retry", {
              dagId,
              nodeId,
              sessionSlug: oldSessionSlug,
              err: (err as Error).message,
            });
          }
        }
      }

      repo.updateNode(nodeId, {
        status: "pending",
        sessionSlug: undefined,
        startedAt: undefined,
        completedAt: undefined,
        failedReason: null,
      });

      ctx.audit.record(
        "operator",
        "dag.node.retry",
        { kind: "dag-node", id: nodeId },
        { dagId, from, to: "pending", oldSessionSlug: oldSessionSlug ?? null },
      );

      await scheduler.tick(dagId);
    },

    async cancel(dagId: string): Promise<void> {
      const dag = repo.get(dagId);
      if (!dag) throw new EngineError("not_found", `dag not found: ${dagId}`);
      const cancelledNodeIds: string[] = [];
      for (const node of dag.nodes) {
        if (
          node.status === "landed" ||
          node.status === "pr-open" ||
          node.status === "merged"
        )
          continue;
        const from: DAGNodeStatus = node.status;
        repo.updateNode(node.id, {
          status: "cancelled",
          completedAt: node.completedAt ?? new Date().toISOString(),
        });
        cancelledNodeIds.push(node.id);
        ctx.audit.record(
          "operator",
          "dag.cancel.node",
          { kind: "dag", id: dagId },
          { nodeId: node.id, from, to: "cancelled" },
        );
      }
      repo.update(dagId, { status: "cancelled" });
      ctx.audit.record("operator", "dag.cancel", { kind: "dag", id: dagId }, { cancelledNodeIds });
    },

    async forceLand(dagId: string, nodeId: string): Promise<void> {
      const dag = repo.get(dagId);
      if (!dag) throw new EngineError("not_found", `dag not found: ${dagId}`);
      const node = repo.getNode(nodeId);
      if (!node) throw new EngineError("not_found", `dag node not found: ${nodeId}`);
      const from = node.status;
      repo.updateNode(nodeId, {
        status: "landed",
        completedAt: node.completedAt ?? new Date().toISOString(),
      });
      ctx.audit.record(
        "operator",
        "dag.force-land",
        { kind: "dag", id: dagId },
        { nodeId, from, to: "landed" },
      );
      await scheduler.tick(dagId);
    },

    async tick(dagId: string): Promise<void> {
      await scheduler.tick(dagId);
    },

    async tryCreateFromTranscript(slug: string): Promise<{ created: boolean; dagId?: string }> {
      return tryCreateFromTranscript(slug);
    },
  };

  // TODO: extract to sidecar (T25)
  const WATCHDOG_INTERVAL_MS = 30_000;
  const watchdogHandle = setInterval(() => {
    scheduler.watchdogTick().catch((err: unknown) => {
      log.error("dag watchdog tick error", { err: (err as Error).message });
    });
  }, WATCHDOG_INTERVAL_MS);
  if (typeof watchdogHandle.unref === "function") watchdogHandle.unref();

  return {
    api,
    registerRoutes(app) {
      registerDagRoutes(app, ctx);
    },
    onShutdown() {
      unsubscribe();
      clearInterval(watchdogHandle);
    },
  };
}

export { DagRepo } from "./model.js";
export { DagScheduler } from "./scheduler.js";
export { parseDagFromTranscript } from "./parser.js";

export function newDagId(): string {
  return newSlug("dag");
}

export function newDagTimestamp(): string {
  return nowIso();
}
