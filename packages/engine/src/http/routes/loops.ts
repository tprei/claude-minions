import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import { EngineError } from "../../errors.js";
import type { LoopDefinition } from "@minions/shared";

type CreateLoopRequest = Omit<LoopDefinition, "id" | "createdAt" | "updatedAt" | "consecutiveFailures">;

export function registerLoopRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/loops", async (_req, reply) => {
    await reply.send({ items: ctx.loops.list() });
  });

  app.post("/api/loops", async (req, reply) => {
    const body = req.body as Partial<CreateLoopRequest> | undefined;
    if (!body || typeof body.label !== "string" || typeof body.prompt !== "string" || typeof body.intervalSec !== "number") {
      throw new EngineError("bad_request", "label, prompt, and intervalSec are required");
    }
    const loop = ctx.loops.upsert(body as CreateLoopRequest);
    await reply.status(201).send(loop);
  });

  app.patch("/api/loops/:id/enabled", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { enabled: boolean } | undefined;
    if (!body || typeof body.enabled !== "boolean") {
      throw new EngineError("bad_request", "enabled is required");
    }
    ctx.loops.setEnabled(id, body.enabled);
    await reply.send({ ok: true });
  });

  app.delete("/api/loops/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    ctx.loops.delete(id);
    await reply.status(204).send();
  });
}
