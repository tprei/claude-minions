import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import type { VersionInfo } from "@minions/shared";

export function registerVersionRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/version", async (_req, reply) => {
    const info: VersionInfo = {
      apiVersion: ctx.env.apiVersion,
      libraryVersion: ctx.env.libraryVersion,
      features: ctx.features(),
      featuresPending: ctx.featuresPending(),
      provider: ctx.env.provider,
      providers: [ctx.env.provider],
      repos: ctx.repos(),
      startedAt: new Date().toISOString(),
    };
    await reply.send(info);
  });
}
