import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";

export function registerAuditRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/audit/events", async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const limit = query["limit"] ? Number.parseInt(query["limit"], 10) : undefined;
    const events = ctx.audit.list(limit);
    await reply.send({ items: events });
  });
}
