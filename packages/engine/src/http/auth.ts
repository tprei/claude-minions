import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { EngineError } from "../errors.js";

export type RouteAuthMode = "public" | "header" | "query-token";

declare module "fastify" {
  interface FastifyContextConfig {
    auth?: RouteAuthMode;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.alloc(aBuf.length);
  Buffer.from(b).copy(bBuf);
  const equal = timingSafeEqual(aBuf, bBuf);
  return equal && a.length === b.length;
}

export function extractBearerToken(
  req: FastifyRequest,
  mode: RouteAuthMode = "header",
): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  if (mode === "query-token") {
    const query = (req.query as Record<string, string | undefined>)["token"];
    return query ?? null;
  }
  return null;
}

export function resolveRouteAuthMode(req: FastifyRequest): RouteAuthMode {
  const config = req.routeOptions?.config as { auth?: RouteAuthMode } | undefined;
  return config?.auth ?? "header";
}

export function buildAuthPreHandler(token: string) {
  return async function authPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const mode = resolveRouteAuthMode(req);
    if (mode === "public") return;
    const provided = extractBearerToken(req, mode);
    if (!provided || !constantTimeEqual(provided, token)) {
      const err = new EngineError("unauthorized", "Missing or invalid token");
      await reply.status(err.status).send(err.toJSON());
      return;
    }
  };
}
