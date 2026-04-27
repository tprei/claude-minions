import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../context.js";
import { EngineError } from "../errors.js";

export function registerDagRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/dags", async (_req, reply) => {
    const dags = ctx.dags.list();
    await reply.send(dags);
  });

  app.get<{ Params: { id: string } }>("/api/dags/:id", async (req, reply) => {
    const dag = ctx.dags.get(req.params.id);
    if (!dag) throw new EngineError("not_found", `dag not found: ${req.params.id}`);
    await reply.send(dag);
  });
}
