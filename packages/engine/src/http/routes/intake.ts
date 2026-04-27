import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import { EngineError } from "../../errors.js";
import type { IngestExternalTaskRequest } from "@minions/shared";

export function registerIntakeRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/intake/tasks", async (_req, reply) => {
    await reply.send({ items: ctx.intake.list() });
  });

  app.post("/api/intake/tasks", async (req, reply) => {
    const body = req.body as IngestExternalTaskRequest | undefined;
    if (!body || typeof body.source !== "string" || typeof body.externalId !== "string") {
      throw new EngineError("bad_request", "source and externalId are required");
    }
    const task = await ctx.intake.ingest(body);
    await reply.status(201).send(task);
  });
}
