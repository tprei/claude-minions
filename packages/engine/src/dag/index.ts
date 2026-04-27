import type { DAG, DAGSplitRequest, StatusEvent } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { DagRepo } from "./model.js";
import { DagScheduler } from "./scheduler.js";
import { DagTerminalHandler } from "./onTerminal.js";
import { registerDagRoutes } from "./routes.js";
import { parseDagFromTranscript } from "./parser.js";
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

async function dispatchAfterBootReconcile(
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

export function createDagSubsystem(deps: SubsystemDeps): SubsystemResult<EngineContext["dags"]> {
  const { ctx, db, bus, log } = deps;

  const repo = new DagRepo(db, bus);
  const scheduler = new DagScheduler(repo, ctx, log.child({ subsystem: "dag-scheduler" }));
  const terminalHandler = new DagTerminalHandler(
    repo,
    scheduler,
    ctx,
    log.child({ subsystem: "dag-terminal" }),
  );

  const reconciledDagIds = reconcileStaleRunningNodes(db, repo, ctx, log);
  dispatchAfterBootReconcile(scheduler, reconciledDagIds, ctx, log).catch((err) => {
    log.error("dag boot reconcile dispatch error", { err: (err as Error).message });
  });

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
      DAG_FENCE_DETECT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = DAG_FENCE_DETECT_RE.exec(ev.text)) !== null) {
        const body = m[1];
        if (body) blocks.push(body.trim());
      }
    }
    return blocks;
  }

  const unsubscribe = bus.on("transcript_event", (event) => {
    const slug = event.sessionSlug;
    const session = ctx.sessions.get(slug);
    if (!session) return;
    if (session.mode !== "ship") return;
    if (session.shipStage !== "dag") return;

    const transcript = ctx.sessions.transcript(slug);
    const parsed = parseDagFromTranscript(transcript);

    if (parsed) {
      const existing = repo.byRootSession(slug);
      if (existing) return;
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
      } catch (err) {
        subLog.error("failed to create dag from parsed transcript", {
          slug,
          err: (err as Error).message,
        });
      }
      return;
    }

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
  };

  return {
    api,
    registerRoutes(app) {
      registerDagRoutes(app, ctx);
    },
    onShutdown() {
      unsubscribe();
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
