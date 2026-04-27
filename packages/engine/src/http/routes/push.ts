import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import { EngineError } from "../../errors.js";
import type { PushSubscriptionInfo } from "@minions/shared";

export function registerPushRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/push/vapid-public-key", async (_req, reply) => {
    const key = ctx.push.vapidPublicKey();
    if (!key) throw new EngineError("not_found", "VAPID not configured");
    await reply.send({ publicKey: key });
  });

  app.post("/api/push-subscribe", async (req, reply) => {
    const body = req.body as PushSubscriptionInfo | undefined;
    if (!body || typeof body.endpoint !== "string") {
      throw new EngineError("bad_request", "endpoint is required");
    }
    await ctx.push.subscribe(body);
    await reply.status(201).send({ ok: true });
  });

  app.delete("/api/push-subscribe", async (req, reply) => {
    const body = req.body as { endpoint: string } | undefined;
    if (!body || typeof body.endpoint !== "string") {
      throw new EngineError("bad_request", "endpoint is required");
    }
    await ctx.push.unsubscribe(body.endpoint);
    await reply.status(204).send();
  });
}
