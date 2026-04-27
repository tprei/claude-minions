import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../context.js";
import { EngineError } from "../errors.js";

export function registerIntakeRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.post("/api/intake", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body["source"] !== "string" || typeof body["externalId"] !== "string" || typeof body["title"] !== "string") {
      throw new EngineError("bad_request", "source, externalId, and title are required");
    }
    const task = await ctx.intake.ingest({
      source: body["source"] as import("@minions/shared").ExternalSource,
      externalId: body["externalId"],
      title: body["title"],
      body: typeof body["body"] === "string" ? body["body"] : "",
      url: typeof body["url"] === "string" ? body["url"] : undefined,
      prompt: typeof body["prompt"] === "string" ? body["prompt"] : undefined,
      mode: (["task", "review", "ship"].includes(body["mode"] as string)
        ? body["mode"]
        : undefined) as import("@minions/shared").IngestExternalTaskRequest["mode"],
      repoId: typeof body["repoId"] === "string" ? body["repoId"] : undefined,
      metadata: typeof body["metadata"] === "object" && body["metadata"] !== null
        ? body["metadata"] as Record<string, unknown>
        : undefined,
    });
    await reply.status(201).send(task);
  });

  app.get("/api/intake", async (_req, reply) => {
    await reply.send(ctx.intake.list());
  });
}
