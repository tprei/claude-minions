import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";

export function registerReadinessRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/readiness/summary", async (_req, reply) => {
    await reply.send(ctx.readiness.summary());
  });
}
