import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";
import type { DagRepo } from "./model.js";
import type { DagScheduler } from "./scheduler.js";

export class DagMergedHandler {
  constructor(
    private readonly repo: DagRepo,
    private readonly scheduler: DagScheduler,
    private readonly ctx: EngineContext,
    private readonly log: Logger,
  ) {}

  async handle(sessionSlug: string): Promise<void> {
    const node = this.repo.getNodeBySession(sessionSlug);
    if (!node) return;
    if (node.status !== "pr-open" && node.status !== "landed") return;

    const dag = this.repo.byNodeSession(sessionSlug);
    if (!dag) return;

    this.repo.updateNode(node.id, { status: "merged" });
    this.ctx.audit.record(
      "system",
      "dag.node.merged",
      { kind: "dag-node", id: node.id },
      { dagId: dag.id, sessionSlug, from: node.status },
    );
    this.log.info("dag node merged", { dagId: dag.id, nodeId: node.id, sessionSlug });

    await this.scheduler.tick(dag.id);
  }
}
