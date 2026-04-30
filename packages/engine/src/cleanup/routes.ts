import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CLEANUPABLE_STATUSES,
  type CleanupCandidatesResponse,
  type CleanupableStatus,
} from "@minions/shared";
import type { EngineContext } from "../context.js";
import { EngineError } from "../errors.js";

const MAX_CANDIDATES = 200;
const STATUS_SET: ReadonlySet<string> = new Set(CLEANUPABLE_STATUSES);

interface CandidatesQuery {
  olderThanDays?: string;
  statuses?: string;
}

function parseStatuses(raw: string): CleanupableStatus[] {
  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  const invalid = parts.filter((p) => !STATUS_SET.has(p));
  if (invalid.length > 0) {
    throw new EngineError("bad_request", `Invalid status(es): ${invalid.join(", ")}`, {
      invalid,
      allowed: [...STATUS_SET],
    });
  }
  return parts as CleanupableStatus[];
}

function parseOlderThanDays(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new EngineError("bad_request", "olderThanDays must be a non-negative number");
  }
  return n;
}

function validateBody(body: unknown): { slugs: string[]; removeWorktree: boolean } {
  if (!body || typeof body !== "object") {
    throw new EngineError("bad_request", "Body must be an object");
  }
  const b = body as { slugs?: unknown; removeWorktree?: unknown };
  if (!Array.isArray(b.slugs)) {
    throw new EngineError("bad_request", "slugs must be an array");
  }
  if (b.slugs.some((s) => typeof s !== "string")) {
    throw new EngineError("bad_request", "slugs must be an array of strings");
  }
  if (typeof b.removeWorktree !== "boolean") {
    throw new EngineError("bad_request", "removeWorktree must be a boolean");
  }
  return { slugs: b.slugs as string[], removeWorktree: b.removeWorktree };
}

export function registerCleanupRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get(
    "/api/cleanup/candidates",
    async (req: FastifyRequest<{ Querystring: CandidatesQuery }>, reply) => {
      const olderThanDays =
        req.query.olderThanDays !== undefined ? parseOlderThanDays(req.query.olderThanDays) : 7;
      const statuses = req.query.statuses
        ? parseStatuses(req.query.statuses)
        : [...CLEANUPABLE_STATUSES];

      const all = await ctx.cleanup.selectCandidates({ olderThanDays, statuses });
      const truncated = all.length > MAX_CANDIDATES;
      const items = truncated ? all.slice(0, MAX_CANDIDATES) : all;
      const body: CleanupCandidatesResponse = { items, truncated };
      return reply.send(body);
    },
  );

  app.post("/api/cleanup/preview", async (req, reply) => {
    const valid = validateBody(req.body);
    const result = await ctx.cleanup.preview(valid);
    return reply.send(result);
  });

  app.post("/api/cleanup/execute", async (req, reply) => {
    const valid = validateBody(req.body);
    const result = await ctx.cleanup.execute(valid);
    return reply.send(result);
  });
}
