import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../context.js";
import { EngineError } from "../errors.js";

export function registerLoopsRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/loops", async (_req, reply) => {
    await reply.send(ctx.loops.list());
  });

  app.post("/api/loops", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body["prompt"] !== "string" || typeof body["intervalSec"] !== "number") {
      throw new EngineError("bad_request", "prompt and intervalSec are required");
    }
    const loop = ctx.loops.upsert({
      label: typeof body["label"] === "string" ? body["label"] : body["prompt"].slice(0, 60),
      prompt: body["prompt"],
      intervalSec: body["intervalSec"],
      enabled: typeof body["enabled"] === "boolean" ? body["enabled"] : true,
      modelHint: typeof body["modelHint"] === "string" ? body["modelHint"] : undefined,
      repoId: typeof body["repoId"] === "string" ? body["repoId"] : undefined,
      baseBranch: typeof body["baseBranch"] === "string" ? body["baseBranch"] : undefined,
      jitterPct: typeof body["jitterPct"] === "number" ? body["jitterPct"] : 0.1,
      maxConcurrent: typeof body["maxConcurrent"] === "number" ? body["maxConcurrent"] : 1,
      nextRunAt: typeof body["nextRunAt"] === "string" ? body["nextRunAt"] : undefined,
      lastRunAt: typeof body["lastRunAt"] === "string" ? body["lastRunAt"] : undefined,
      lastSessionSlug: typeof body["lastSessionSlug"] === "string" ? body["lastSessionSlug"] : undefined,
    });
    await reply.status(201).send(loop);
  });

  app.patch("/api/loops/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const existing = ctx.loops.list().find((l) => l.id === id);
    if (!existing) {
      throw new EngineError("not_found", `Loop ${id} not found`);
    }
    if (typeof body["enabled"] === "boolean") {
      ctx.loops.setEnabled(id, body["enabled"]);
    }
    const updated = ctx.loops.upsert({
      ...existing,
      ...Object.fromEntries(
        Object.entries(body).filter(([k]) =>
          ["label", "prompt", "intervalSec", "modelHint", "repoId", "baseBranch", "jitterPct", "maxConcurrent"].includes(k),
        ),
      ),
      id,
    } as Parameters<typeof ctx.loops.upsert>[0]);
    await reply.send(updated);
  });

  app.delete("/api/loops/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = ctx.loops.list().find((l) => l.id === id);
    if (!existing) {
      throw new EngineError("not_found", `Loop ${id} not found`);
    }
    ctx.loops.delete(id);
    await reply.status(204).send();
  });
}
