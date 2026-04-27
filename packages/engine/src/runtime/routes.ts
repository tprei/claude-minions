import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../context.js";

export function registerRuntimeRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/config/runtime", async (_req, reply) => {
    await reply.send({
      schema: ctx.runtime.schema(),
      values: ctx.runtime.values(),
      effective: ctx.runtime.effective(),
    });
  });

  app.patch("/api/config/runtime", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    await ctx.runtime.update(body);
    await reply.send({
      schema: ctx.runtime.schema(),
      values: ctx.runtime.values(),
      effective: ctx.runtime.effective(),
    });
  });
}
