import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import type { EngineContext } from "../context.js";
import { EngineError, isEngineError } from "../errors.js";
import { buildAuthPreHandler } from "./auth.js";

export async function buildHttpServer(ctx: EngineContext): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({
    logger: false,
    bodyLimit: 25 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: ctx.env.corsOrigins,
    credentials: true,
  });

  await app.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024,
    },
  });

  await app.register(staticFiles, {
    root: ctx.workspaceDir,
    prefix: "/files/",
    decorateReply: true,
    serve: false,
  });

  app.addHook("preHandler", async (req, reply) => {
    const url = req.url.split("?")[0];
    if (url === "/api/health") {
      return;
    }
    if (url === "/api/events") {
      return;
    }
    await buildAuthPreHandler(ctx.env.token)(req, reply);
  });

  app.setErrorHandler(async (err, _req, reply) => {
    if (isEngineError(err)) {
      await reply.status(err.status).send(err.toJSON());
      return;
    }
    const e = err as Error;
    ctx.log.error("unhandled error", { message: e.message, stack: e.stack });
    await reply.status(500).send({ error: "internal", message: e.message });
  });

  return app;
}
