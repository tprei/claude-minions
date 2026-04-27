import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../context.js";
import { buildAuthPreHandler } from "./auth.js";

export function attachSseRoute(app: FastifyInstance, ctx: EngineContext): void {
  app.get(
    "/api/events",
    { preHandler: buildAuthPreHandler(ctx.env.token) },
    async (req, reply) => {
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");
      reply.raw.flushHeaders();

      function send(eventKind: string, data: unknown): void {
        if (reply.raw.writableEnded) return;
        reply.raw.write(
          `retry: 5000\nevent: ${eventKind}\ndata: ${JSON.stringify(data)}\n\n`
        );
      }

      const hello = {
        kind: "hello" as const,
        serverTime: new Date().toISOString(),
        apiVersion: ctx.env.apiVersion,
      };
      send("hello", hello);

      const unsubscribe = ctx.bus.onAny((event) => {
        send(event.kind, event);
      });

      const pingInterval = setInterval(() => {
        if (reply.raw.writableEnded) {
          clearInterval(pingInterval);
          return;
        }
        const ping = {
          kind: "ping" as const,
          serverTime: new Date().toISOString(),
        };
        reply.raw.write(`event: ping\ndata: ${JSON.stringify(ping)}\n\n`);
      }, ctx.env.ssePingSec * 1000);

      req.raw.on("close", () => {
        clearInterval(pingInterval);
        unsubscribe();
      });

      await new Promise<void>((resolve) => {
        req.raw.on("close", resolve);
      });
    }
  );
}
