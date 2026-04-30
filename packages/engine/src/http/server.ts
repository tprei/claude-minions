import path from "node:path";
import fs from "node:fs";
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

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const raw = typeof body === "string" ? body : "";
      if (raw.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        (err as Error & { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

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

  const authPreHandler = buildAuthPreHandler(ctx.env.token);
  app.addHook("preHandler", async (req, reply) => {
    const url = req.url.split("?")[0] ?? "";
    if (!url.startsWith("/api/")) return;
    await authPreHandler(req, reply);
  });

  if (ctx.env.webDist) {
    const webDist = ctx.env.webDist;
    if (!fs.existsSync(webDist)) {
      ctx.log.warn("MINIONS_WEB_DIST not found; web will not be served", { webDist });
    } else {
      await app.register(staticFiles, {
        root: webDist,
        prefix: "/",
        decorateReply: false,
        wildcard: false,
      });
      const indexHtml = path.join(webDist, "index.html");
      app.setNotFoundHandler(async (req, reply) => {
        if (req.url.startsWith("/api/")) {
          await reply.status(404).send({ error: "not_found", message: `Route ${req.method}:${req.url} not found` });
          return;
        }
        if (fs.existsSync(indexHtml)) {
          const html = fs.readFileSync(indexHtml, "utf8");
          await reply.type("text/html").send(html);
          return;
        }
        await reply.status(404).send({ error: "not_found", message: "Web bundle not built" });
      });
      ctx.log.info("serving web bundle", { webDist });
    }
  }

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
