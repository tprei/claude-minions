import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import type { ResourceSnapshot, VersionInfo } from "@minions/shared";
import { runDoctorChecks } from "../../version/probes.js";
import { computeAlerts } from "../../doctor/alerts.js";
import { resolveResourceFloors } from "../../sessions/admission.js";

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
    const checks = await runDoctorChecks(ctx);
    const runtime = ctx.runtime.effective();
    const floors = resolveResourceFloors(runtime);
    const rawMax = runtime["ciSelfHealMaxAttempts"];
    const ciSelfHealMaxAttempts =
      typeof rawMax === "number" && Number.isFinite(rawMax) ? rawMax : 3;
    const alerts = computeAlerts({
      sessions: ctx.sessions.list(),
      resource,
      checks,
      diskFloorBytes: floors.diskFloorBytes,
      ciSelfHealMaxAttempts,
      now: new Date(),
    });
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
      checks,
      alerts,
    });
  });
}
