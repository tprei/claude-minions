import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fs from "node:fs";
import {
  SESSION_STATUSES,
  SESSION_MODES,
  SESSION_BUCKETS,
  type SessionStatus,
  type SessionMode,
  type SessionBucket,
  type ListEnvelope,
  type Session,
} from "@minions/shared";
import type { EngineContext } from "../context.js";
import { EngineError } from "../errors.js";
import type { PageCursor } from "../store/repos/sessionRepo.js";

const STATUS_SET: ReadonlySet<string> = new Set(SESSION_STATUSES);
const MODE_SET: ReadonlySet<string> = new Set(SESSION_MODES);
const BUCKET_SET: ReadonlySet<string> = new Set(SESSION_BUCKETS);

interface ListSessionsQuery {
  status?: string;
  mode?: string;
  repoId?: string;
  q?: string;
  limit?: string;
  cursor?: string;
}

function parseCsvEnum<T extends string>(
  raw: string,
  allowed: ReadonlySet<string>,
  paramName: string,
): T[] {
  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  const invalid = parts.filter((p) => !allowed.has(p));
  if (invalid.length > 0) {
    throw new EngineError(
      "bad_request",
      `Invalid ${paramName} value(s): ${invalid.join(", ")}`,
      { invalid, allowed: [...allowed] },
    );
  }
  return parts as T[];
}

function parseLimit(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new EngineError("bad_request", "limit must be an integer between 1 and 200");
  }
  return n;
}

function decodeCursor(raw: string): PageCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    throw new EngineError("bad_request", "Invalid cursor");
  }
  const sep = decoded.lastIndexOf(":");
  if (sep <= 0 || sep === decoded.length - 1) {
    throw new EngineError("bad_request", "Invalid cursor");
  }
  return { updatedAt: decoded.slice(0, sep), slug: decoded.slice(sep + 1) };
}

function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(`${cursor.updatedAt}:${cursor.slug}`, "utf8").toString("base64");
}

export function registerSessionsRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get(
    "/api/sessions",
    async (req: FastifyRequest<{ Querystring: ListSessionsQuery }>, reply) => {
      const q = req.query;
      const status = q.status ? parseCsvEnum<SessionStatus>(q.status, STATUS_SET, "status") : undefined;
      const mode = q.mode ? parseCsvEnum<SessionMode>(q.mode, MODE_SET, "mode") : undefined;
      const limit = q.limit ? parseLimit(q.limit) : 100;
      const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;

      const result = ctx.sessions.listPaged({
        status,
        mode,
        repoId: q.repoId,
        q: q.q,
        limit,
        cursor,
      });

      const envelope: ListEnvelope<Session> = { items: result.items };
      if (result.nextCursor) {
        envelope.nextCursor = encodeCursor(result.nextCursor);
      }
      return reply.send(envelope);
    },
  );

  app.get("/api/sessions/:slug", async (req: FastifyRequest<{ Params: { slug: string } }>, reply) => {
    const session = ctx.sessions.get(req.params.slug);
    if (!session) {
      throw new EngineError("not_found", `Session ${req.params.slug} not found`);
    }
    return reply.send(session);
  });

  app.post("/api/sessions", async (req: FastifyRequest<{ Body: import("@minions/shared").CreateSessionRequest }>, reply) => {
    const session = await ctx.sessions.create(req.body);
    return reply.code(201).send(session);
  });

  app.patch("/api/sessions/:slug", async (req: FastifyRequest<{
    Params: { slug: string };
    Body: { bucket?: SessionBucket | null };
  }>, reply) => {
    const session = ctx.sessions.get(req.params.slug);
    if (!session) throw new EngineError("not_found", `Session ${req.params.slug} not found`);
    const body = req.body ?? {};
    if ("bucket" in body) {
      const b = body.bucket;
      if (b !== null && b !== undefined && !BUCKET_SET.has(b)) {
        throw new EngineError("bad_request", `Invalid bucket: ${b}`, { allowed: [...BUCKET_SET] });
      }
      ctx.sessions.updateBucket(req.params.slug, b ?? null);
    }
    return reply.send(ctx.sessions.get(req.params.slug));
  });

  app.delete("/api/sessions/:slug", async (req: FastifyRequest<{ Params: { slug: string } }>, reply) => {
    await ctx.sessions.delete(req.params.slug);
    return reply.send({ ok: true });
  });

  app.get(
    "/api/sessions/:slug/transcript",
    async (
      req: FastifyRequest<{ Params: { slug: string }; Querystring: { since?: string } }>,
      reply,
    ) => {
      const session = ctx.sessions.get(req.params.slug);
      if (!session) {
        throw new EngineError("not_found", `Session ${req.params.slug} not found`);
      }
      let sinceSeq: number | undefined;
      const rawSince = req.query.since;
      if (rawSince !== undefined && rawSince !== "") {
        if (!/^\d+$/.test(rawSince)) {
          throw new EngineError("bad_request", "since must be a non-negative integer");
        }
        const n = Number(rawSince);
        if (!Number.isInteger(n) || n < 0) {
          throw new EngineError("bad_request", "since must be a non-negative integer");
        }
        sinceSeq = n;
      }
      return reply.send({ items: ctx.sessions.transcript(req.params.slug, sinceSeq) });
    },
  );

  app.get("/api/sessions/:slug/diff", async (req: FastifyRequest<{ Params: { slug: string } }>, reply) => {
    const session = ctx.sessions.get(req.params.slug);
    if (!session) {
      throw new EngineError("not_found", `Session ${req.params.slug} not found`);
    }
    const diff = await ctx.sessions.diff(req.params.slug);
    return reply.send(diff);
  });

  app.get("/api/sessions/:slug/screenshots", async (req: FastifyRequest<{ Params: { slug: string } }>, reply) => {
    const session = ctx.sessions.get(req.params.slug);
    if (!session) {
      throw new EngineError("not_found", `Session ${req.params.slug} not found`);
    }
    const screenshots = await ctx.sessions.screenshots(req.params.slug);
    return reply.send({ items: screenshots });
  });

  app.get(
    "/api/sessions/:slug/screenshots/:filename",
    async (req: FastifyRequest<{ Params: { slug: string; filename: string } }>, reply: FastifyReply) => {
      const session = ctx.sessions.get(req.params.slug);
      if (!session) {
        throw new EngineError("not_found", `Session ${req.params.slug} not found`);
      }
      const { filename } = req.params;
      if (
        filename.length === 0 ||
        filename.includes("/") ||
        filename.includes("\\") ||
        filename.includes("..") ||
        filename.startsWith(".")
      ) {
        throw new EngineError("bad_request", "invalid filename");
      }
      const filePath = ctx.sessions.screenshotPath(req.params.slug, filename);
      try {
        await fs.promises.stat(filePath);
      } catch (err) {
        const errno = err as NodeJS.ErrnoException;
        if (errno.code === "ENOENT") {
          return reply.code(404).send({ error: "not_found", message: "Screenshot not found" });
        }
        return reply.code(500).send({ error: "internal", message: String(err) });
      }
      const stream = fs.createReadStream(filePath);
      stream.on("error", (err) => {
        if (reply.raw.headersSent || reply.raw.writableEnded) return;
        const errno = err as NodeJS.ErrnoException;
        if (errno.code === "ENOENT") {
          reply.code(404).send({ error: "not_found", message: "Screenshot not found" });
        } else {
          reply.code(500).send({ error: "internal", message: String(err) });
        }
      });
      return reply.type("image/png").send(stream);
    },
  );

  app.get("/api/sessions/:slug/pr", async (req: FastifyRequest<{ Params: { slug: string } }>, reply) => {
    const session = ctx.sessions.get(req.params.slug);
    if (!session) {
      throw new EngineError("not_found", `Session ${req.params.slug} not found`);
    }
    if (!session.pr || !session.repoId) {
      throw new EngineError("not_found", `Session ${req.params.slug} has no PR`);
    }
    if (!ctx.github.enabled()) {
      throw new EngineError("not_found", "GitHub integration not enabled");
    }
    const pr = await ctx.github.fetchPR(session.repoId, session.pr.number);
    return reply.send(pr);
  });

  app.get("/api/sessions/:slug/readiness", async (req: FastifyRequest<{ Params: { slug: string } }>, reply) => {
    const session = ctx.sessions.get(req.params.slug);
    if (!session) {
      throw new EngineError("not_found", `Session ${req.params.slug} not found`);
    }
    const readiness = await ctx.readiness.compute(req.params.slug);
    return reply.send(readiness);
  });

  app.get("/api/sessions/:slug/checkpoints", async (req: FastifyRequest<{ Params: { slug: string } }>, reply) => {
    const session = ctx.sessions.get(req.params.slug);
    if (!session) {
      throw new EngineError("not_found", `Session ${req.params.slug} not found`);
    }
    return reply.send({ items: ctx.sessions.checkpoints(req.params.slug) });
  });

  app.post(
    "/api/sessions/:slug/checkpoints/:id/restore",
    async (req: FastifyRequest<{ Params: { slug: string; id: string } }>, reply) => {
      const session = ctx.sessions.get(req.params.slug);
      if (!session) {
        throw new EngineError("not_found", `Session ${req.params.slug} not found`);
      }
      await ctx.sessions.restoreCheckpoint(req.params.slug, req.params.id);
      return reply.send({ ok: true });
    },
  );
}
