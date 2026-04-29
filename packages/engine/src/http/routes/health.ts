import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import {
  computeProviderHealth,
  type ProviderHealthEntry,
  type ProviderHealthStatus,
} from "../../version/probes.js";

interface HealthResponse {
  ok: boolean;
  time: string;
  providers: Record<string, ProviderHealthStatus>;
  providerDetails: Record<string, ProviderHealthEntry>;
}

export function registerHealthRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/health", { config: { auth: "public" } }, async (_req, reply) => {
    const details = await computeProviderHealth();
    const providers: Record<string, ProviderHealthStatus> = {};
    for (const [name, entry] of Object.entries(details)) {
      providers[name] = entry.status;
    }

    const configured = ctx.env.provider;
    const configuredEntry = details[configured];
    const ok = configuredEntry ? configuredEntry.status === "ok" : false;

    const body: HealthResponse = {
      ok,
      time: new Date().toISOString(),
      providers,
      providerDetails: details,
    };
    await reply.send(body);
  });
}
