import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import { listProviders } from "../../providers/registry.js";

interface ProviderStatus {
  name: string;
  status: "ready" | "degraded";
  reason?: string;
}

interface HealthResponse {
  ok: boolean;
  time: string;
  providers: ProviderStatus[];
}

export function registerHealthRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/health", { config: { auth: "public" } }, async (_req, reply) => {
    const entries = listProviders();
    const providers: ProviderStatus[] = await Promise.all(
      entries.map(async (entry): Promise<ProviderStatus> => {
        const result = await entry.ready();
        if (result === true) {
          return { name: entry.name, status: "ready" };
        }
        return { name: entry.name, status: "degraded", reason: result };
      }),
    );

    const configured = ctx.env.provider;
    const configuredEntry = providers.find((p) => p.name === configured);
    const ok = configuredEntry ? configuredEntry.status === "ready" : false;

    const body: HealthResponse = {
      ok,
      time: new Date().toISOString(),
      providers,
    };
    await reply.send(body);
  });
}
