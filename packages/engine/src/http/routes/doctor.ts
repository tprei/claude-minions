import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import type { ResourceSnapshot, VersionInfo } from "@minions/shared";

export function registerDoctorRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/doctor", async (_req, reply) => {
    const stats = ctx.stats.global();
    const version: VersionInfo = {
      apiVersion: ctx.env.apiVersion,
      libraryVersion: ctx.env.libraryVersion,
      features: ctx.features(),
      featuresPending: ctx.featuresPending(),
      provider: ctx.env.provider,
      providers: [ctx.env.provider],
      repos: ctx.repos(),
      startedAt: new Date().toISOString(),
    };
    const resource: ResourceSnapshot | null = ctx.resource.latest();
    await reply.send({
      health: { ok: true, time: new Date().toISOString() },
      version,
      sessions: {
        total: stats.totals.sessions,
        running: stats.totals.running,
        waiting: stats.totals.waiting,
        completed: stats.totals.completed,
        failed: stats.totals.failed,
      },
      memoryPending: ctx.memory.list({ status: "pending" }).length,
      resource,
    });
  });
}
