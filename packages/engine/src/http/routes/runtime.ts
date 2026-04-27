import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import type { RuntimeOverrides } from "@minions/shared";

export function registerRuntimeRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/config/runtime", async (_req, reply) => {
    await reply.send({
      schema: ctx.runtime.schema(),
      values: ctx.runtime.values(),
      effective: ctx.runtime.effective(),
    });
  });

  app.patch("/api/config/runtime", async (req, reply) => {
    const patch = req.body as RuntimeOverrides | undefined;
    if (!patch || typeof patch !== "object") {
      await reply.send({
        schema: ctx.runtime.schema(),
        values: ctx.runtime.values(),
        effective: ctx.runtime.effective(),
      });
      return;
    }
    await ctx.runtime.update(patch);
    await reply.send({
      schema: ctx.runtime.schema(),
      values: ctx.runtime.values(),
      effective: ctx.runtime.effective(),
    });
  });
}
