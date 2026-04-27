import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import { EngineError } from "../../errors.js";
import type { CreateSessionRequest, CreateVariantsRequest } from "@minions/shared";

export function registerSessionRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/sessions", async (_req, reply) => {
    await reply.send({ items: ctx.sessions.list() });
  });

  app.get("/api/sessions/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const session = ctx.sessions.get(slug);
    if (!session) throw new EngineError("not_found", `Session ${slug} not found`);
    await reply.send(session);
  });

  app.post("/api/sessions", async (req, reply) => {
    const body = req.body as CreateSessionRequest | undefined;
    if (!body || typeof body.prompt !== "string" || body.prompt.trim() === "") {
      throw new EngineError("bad_request", "prompt is required");
    }
    const session = await ctx.sessions.create(body);
    await reply.status(201).send(session);
  });

  app.delete("/api/sessions/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    await ctx.sessions.close(slug, true);
    await reply.status(204).send();
  });

  app.get("/api/sessions/:slug/transcript", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const session = ctx.sessions.get(slug);
    if (!session) throw new EngineError("not_found", `Session ${slug} not found`);
    const events = ctx.sessions.transcript(slug);
    await reply.send({ items: events });
  });

  app.get("/api/sessions/:slug/diff", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const diff = await ctx.sessions.diff(slug);
    await reply.send(diff);
  });

  app.get("/api/sessions/:slug/screenshots", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const screenshots = await ctx.sessions.screenshots(slug);
    await reply.send({ items: screenshots });
  });

  app.get("/api/sessions/:slug/screenshots/:filename", async (req, reply) => {
    const { slug, filename } = req.params as { slug: string; filename: string };
    const filePath = ctx.sessions.screenshotPath(slug, filename);
    return reply.sendFile(path.basename(filePath), path.dirname(filePath));
  });

  app.get("/api/sessions/:slug/pr", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const session = ctx.sessions.get(slug);
    if (!session) throw new EngineError("not_found", `Session ${slug} not found`);
    if (!session.repoId || !session.pr) {
      throw new EngineError("not_found", "No PR associated with this session");
    }
    const preview = await ctx.github.fetchPR(session.repoId, session.pr.number);
    await reply.send(preview);
  });

  app.get("/api/sessions/:slug/readiness", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const readiness = await ctx.readiness.compute(slug);
    await reply.send(readiness);
  });

  app.get("/api/sessions/:slug/checkpoints", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const checkpoints = ctx.sessions.checkpoints(slug);
    await reply.send({ items: checkpoints });
  });

  app.post("/api/sessions/:slug/checkpoints/:id/restore", async (req, reply) => {
    const { slug, id } = req.params as { slug: string; id: string };
    await ctx.sessions.restoreCheckpoint(slug, id);
    await reply.send({ ok: true });
  });

  app.post("/api/sessions/variants", async (req, reply) => {
    const body = req.body as CreateVariantsRequest | undefined;
    if (!body || typeof body.prompt !== "string" || body.prompt.trim() === "") {
      throw new EngineError("bad_request", "prompt is required");
    }
    if (typeof body.count !== "number" || body.count < 1) {
      throw new EngineError("bad_request", "count must be a positive number");
    }
    const result = await ctx.variants.spawn(body);
    await reply.status(201).send(result);
  });
}
