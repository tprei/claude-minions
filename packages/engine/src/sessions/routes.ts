import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fs from "node:fs";
import type { EngineContext } from "../context.js";
import { EngineError } from "../errors.js";

export function registerSessionsRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/sessions", async (_req, reply) => {
    return reply.send({ items: ctx.sessions.list() });
  });

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

  app.delete("/api/sessions/:slug", async (req: FastifyRequest<{ Params: { slug: string } }>, reply) => {
    await ctx.sessions.close(req.params.slug, true);
    return reply.send({ ok: true });
  });

  app.get("/api/sessions/:slug/transcript", async (req: FastifyRequest<{ Params: { slug: string } }>, reply) => {
    const session = ctx.sessions.get(req.params.slug);
    if (!session) {
      throw new EngineError("not_found", `Session ${req.params.slug} not found`);
    }
    return reply.send({ items: ctx.sessions.transcript(req.params.slug) });
  });

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
      const filePath = ctx.sessions.screenshotPath(req.params.slug, req.params.filename);
      const stream = fs.createReadStream(filePath);
      stream.on("error", () => {
        reply.code(404).send({ error: "not_found", message: "Screenshot not found" });
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
