import type { FastifyInstance } from "fastify";
import type { CreateVariantsRequest, CreateVariantsResponse } from "@minions/shared";
import type { EngineContext } from "../context.js";
import { EngineError } from "../errors.js";

const ALLOWED_FIELDS = new Set([
  "prompt",
  "count",
  "repoId",
  "baseBranch",
  "modelHint",
  "judgeRubric",
]);

export function parseCreateVariantsRequest(body: unknown): CreateVariantsRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new EngineError("bad_request", "request body must be an object");
  }
  const obj = body as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new EngineError("bad_request", `unknown field: ${key}`);
    }
  }

  if (typeof obj["prompt"] !== "string" || obj["prompt"].length === 0) {
    throw new EngineError("bad_request", "prompt must be a non-empty string");
  }
  if (typeof obj["count"] !== "number" || !Number.isInteger(obj["count"])) {
    throw new EngineError("bad_request", "count must be an integer");
  }
  if (obj["count"] < 1 || obj["count"] > 10) {
    throw new EngineError("bad_request", "count must be between 1 and 10");
  }

  const req: CreateVariantsRequest = {
    prompt: obj["prompt"],
    count: obj["count"],
  };

  if (obj["repoId"] !== undefined) {
    if (typeof obj["repoId"] !== "string") {
      throw new EngineError("bad_request", "repoId must be a string");
    }
    req.repoId = obj["repoId"];
  }
  if (obj["baseBranch"] !== undefined) {
    if (typeof obj["baseBranch"] !== "string") {
      throw new EngineError("bad_request", "baseBranch must be a string");
    }
    req.baseBranch = obj["baseBranch"];
  }
  if (obj["modelHint"] !== undefined) {
    if (typeof obj["modelHint"] !== "string") {
      throw new EngineError("bad_request", "modelHint must be a string");
    }
    req.modelHint = obj["modelHint"];
  }
  if (obj["judgeRubric"] !== undefined) {
    if (typeof obj["judgeRubric"] !== "string") {
      throw new EngineError("bad_request", "judgeRubric must be a string");
    }
    req.judgeRubric = obj["judgeRubric"];
  }

  return req;
}

export function registerVariantsRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.post("/api/sessions/variants", async (req, reply) => {
    const parsed = parseCreateVariantsRequest(req.body);
    const result: CreateVariantsResponse = await ctx.variants.spawn(parsed);
    await reply.status(201).send(result);
  });
}
