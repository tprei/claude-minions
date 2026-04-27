import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../context.js";
import { EngineError } from "../errors.js";

export function registerVariantsRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.post("/api/sessions/variants", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body["prompt"] !== "string") {
      throw new EngineError("bad_request", "prompt is required");
    }
    const count = typeof body["count"] === "number" ? body["count"] : 2;
    if (count < 1 || count > 10) {
      throw new EngineError("bad_request", "count must be between 1 and 10");
    }
    const result = await ctx.variants.spawn({
      prompt: body["prompt"],
      count,
      repoId: typeof body["repoId"] === "string" ? body["repoId"] : undefined,
      baseBranch: typeof body["baseBranch"] === "string" ? body["baseBranch"] : undefined,
      modelHint: typeof body["modelHint"] === "string" ? body["modelHint"] : undefined,
      judgeRubric: typeof body["judgeRubric"] === "string" ? body["judgeRubric"] : undefined,
    });
    await reply.status(201).send(result);
  });
}
