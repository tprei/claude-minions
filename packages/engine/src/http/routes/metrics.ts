import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";

export function registerMetricsRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/metrics", async (_req, reply) => {
    await reply
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(ctx.stats.promText());
  });
}
