import type { FastifyInstance } from "fastify";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/api/health", async (_req, reply) => {
    await reply.send({ ok: true, time: new Date().toISOString() });
  });
}
