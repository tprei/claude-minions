import type { DAG, DAGSplitRequest } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { DagRepo } from "./model.js";
import { DagScheduler } from "./scheduler.js";
import { DagTerminalHandler } from "./onTerminal.js";
import { registerDagRoutes } from "./routes.js";
import { newSlug } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { EngineError } from "../errors.js";

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
