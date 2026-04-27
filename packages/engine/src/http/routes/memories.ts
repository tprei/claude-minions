import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import { EngineError } from "../../errors.js";
import type { CreateMemoryRequest, MemoryReviewCommand, MemoryStatus, MemoryKind } from "@minions/shared";

const REVIEW_DECISIONS: ReadonlyArray<MemoryReviewCommand["decision"]> = [
  "approve",
  "reject",
  "delete",
  "supersede",
];
const REVIEW_KEYS = new Set(["decision", "reason", "supersedesId"]);

function parseReviewCommand(raw: unknown): MemoryReviewCommand {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EngineError("bad_request", "review body must be an object");
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!REVIEW_KEYS.has(key)) {
      throw new EngineError("bad_request", `unknown field: ${key}`);
    }
  }

  const decision = obj["decision"];
  if (typeof decision !== "string") {
    throw new EngineError("bad_request", "decision is required");
  }
  if (!REVIEW_DECISIONS.includes(decision as MemoryReviewCommand["decision"])) {
    throw new EngineError(
      "bad_request",
      `decision must be one of ${REVIEW_DECISIONS.join("|")}`
    );
  }

  const cmd: MemoryReviewCommand = { decision: decision as MemoryReviewCommand["decision"] };

  if ("reason" in obj && obj["reason"] !== undefined) {
    if (typeof obj["reason"] !== "string") {
      throw new EngineError("bad_request", "reason must be a string");
    }
    cmd.reason = obj["reason"];
  }

  if ("supersedesId" in obj && obj["supersedesId"] !== undefined) {
    if (typeof obj["supersedesId"] !== "string") {
      throw new EngineError("bad_request", "supersedesId must be a string");
    }
    cmd.supersedesId = obj["supersedesId"];
  }

  return cmd;
}

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
    const cmd = parseReviewCommand(req.body);
    const memory = await ctx.memory.review(id, cmd);
    await reply.send(memory);
  });

  app.delete("/api/memories/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await ctx.memory.delete(id);
    await reply.status(204).send();
  });
}
