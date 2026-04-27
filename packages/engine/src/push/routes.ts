import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../context.js";
import type { PushSubscriptionInfo } from "@minions/shared";
import { EngineError } from "../errors.js";

export function registerPushRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/push/vapid-public-key", async (_req, reply) => {
    const key = ctx.push.vapidPublicKey();
    if (!key) {
      throw new EngineError("unsupported", "Push notifications not configured");
    }
    await reply.send({ publicKey: key });
  });

  app.post("/api/push-subscribe", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body["endpoint"] !== "string") {
      throw new EngineError("bad_request", "endpoint is required");
    }
    const keys = body["keys"] as Record<string, unknown> | undefined;
    if (!keys || typeof keys["p256dh"] !== "string" || typeof keys["auth"] !== "string") {
      throw new EngineError("bad_request", "keys.p256dh and keys.auth are required");
    }
    const sub: PushSubscriptionInfo = {
      endpoint: body["endpoint"],
      keys: { p256dh: keys["p256dh"], auth: keys["auth"] },
      userAgent: typeof body["userAgent"] === "string" ? body["userAgent"] : undefined,
    };
    await ctx.push.subscribe(sub);
    await reply.status(201).send({ ok: true });
  });

  app.delete("/api/push-subscribe", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body["endpoint"] !== "string") {
      throw new EngineError("bad_request", "endpoint is required");
    }
    await ctx.push.unsubscribe(body["endpoint"]);
    await reply.status(204).send();
  });
}
