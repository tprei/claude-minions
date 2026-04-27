import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import { EngineError } from "../../errors.js";

export function registerDagRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/dags", async (_req, reply) => {
    await reply.send({ items: ctx.dags.list() });
  });

  app.get("/api/dags/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dag = ctx.dags.get(id);
    if (!dag) throw new EngineError("not_found", `DAG ${id} not found`);
    await reply.send(dag);
  });
}
