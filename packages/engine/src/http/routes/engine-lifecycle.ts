import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";

export function registerEngineLifecycleRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/engine-lifecycle/events", async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const limit = query["limit"] ? Number.parseInt(query["limit"], 10) : undefined;
    const before = query["before"];
    const result = ctx.lifecycle.list(limit, before);
    await reply.send(result);
  });
}
