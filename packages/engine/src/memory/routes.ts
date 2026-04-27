import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../context.js";
import type { MemoryKind, MemoryStatus, ReviewMemoryRequest } from "@minions/shared";
import { EngineError } from "../errors.js";

export function registerMemoryRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/memories", async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const filter: { status?: MemoryStatus; kind?: MemoryKind } = {};
    if (query["status"]) filter.status = query["status"] as MemoryStatus;
    if (query["kind"]) filter.kind = query["kind"] as MemoryKind;
    await reply.send(ctx.memory.list(filter));
  });

  app.post("/api/memories", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body["kind"] !== "string") {
      throw new EngineError("bad_request", "kind is required");
    }
    if (typeof body["title"] !== "string" || body["title"].trim() === "") {
      throw new EngineError("bad_request", "title is required");
    }
    if (typeof body["body"] !== "string" || body["body"].trim() === "") {
      throw new EngineError("bad_request", "body is required");
    }
    if (body["scope"] !== "global" && body["scope"] !== "repo") {
      throw new EngineError("bad_request", "scope must be global or repo");
    }

    const memory = await ctx.memory.create({
      kind: body["kind"] as MemoryKind,
      title: body["title"],
      body: body["body"],
      scope: body["scope"],
      repoId: typeof body["repoId"] === "string" ? body["repoId"] : undefined,
      pinned: typeof body["pinned"] === "boolean" ? body["pinned"] : undefined,
      proposedFromSession: typeof body["proposedFromSession"] === "string" ? body["proposedFromSession"] : undefined,
    });
    await reply.status(201).send(memory);
  });

  app.patch("/api/memories/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const patch: Partial<Pick<import("@minions/shared").Memory, "title" | "body" | "pinned">> = {};
    if (typeof body["title"] === "string") patch.title = body["title"];
    if (typeof body["body"] === "string") patch.body = body["body"];
    if (typeof body["pinned"] === "boolean") patch.pinned = body["pinned"];
    const memory = await ctx.memory.update(id, patch);
    await reply.send(memory);
  });

  app.patch("/api/memories/:id/review", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const valid = ["approve", "reject", "delete", "supersede"];
    if (!valid.includes(body["decision"] as string)) {
      throw new EngineError("bad_request", `decision must be one of ${valid.join("|")}`);
    }
    const reviewReq: ReviewMemoryRequest = {
      decision: body["decision"] as ReviewMemoryRequest["decision"],
      reason: typeof body["reason"] === "string" ? body["reason"] : undefined,
      supersedesId: typeof body["supersedesId"] === "string" ? body["supersedesId"] : undefined,
    };
    const memory = await ctx.memory.review(id, reviewReq);
    await reply.send(memory);
  });

  app.delete("/api/memories/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await ctx.memory.delete(id);
    await reply.status(204).send();
  });
}
