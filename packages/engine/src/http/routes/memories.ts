import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import { EngineError } from "../../errors.js";
import type { CreateMemoryRequest, ReviewMemoryRequest, MemoryStatus, MemoryKind } from "@minions/shared";

export function registerMemoryRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/memories", async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const status = query["status"] as MemoryStatus | undefined;
    const kind = query["kind"] as MemoryKind | undefined;
    const memories = ctx.memory.list({ status, kind });
    await reply.send({ items: memories });
  });

  app.post("/api/memories", async (req, reply) => {
    const body = req.body as CreateMemoryRequest | undefined;
    if (!body || typeof body.title !== "string" || typeof body.body !== "string") {
      throw new EngineError("bad_request", "title and body are required");
    }
    const memory = await ctx.memory.create(body);
    await reply.status(201).send(memory);
  });

  app.patch("/api/memories/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Partial<{ title: string; body: string; pinned: boolean }> | undefined;
    if (!body) throw new EngineError("bad_request", "Request body required");
    const memory = await ctx.memory.update(id, body);
    await reply.send(memory);
  });

  app.patch("/api/memories/:id/review", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as ReviewMemoryRequest | undefined;
    if (!body || !body.decision) {
      throw new EngineError("bad_request", "decision is required");
    }
    const memory = await ctx.memory.review(id, body);
    await reply.send(memory);
  });

  app.delete("/api/memories/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await ctx.memory.delete(id);
    await reply.status(204).send();
  });
}
