import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";

export function registerStatsRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/stats", async (_req, reply) => {
    await reply.send(ctx.stats.global());
  });

  app.get("/api/stats/modes", async (_req, reply) => {
    await reply.send(ctx.stats.modes());
  });

  app.get("/api/stats/recent", async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const hours = query["hours"] ? Number.parseInt(query["hours"], 10) : undefined;
    await reply.send(ctx.stats.recent(hours));
  });
}
