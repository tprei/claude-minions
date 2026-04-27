import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { EngineError } from "../errors.js";

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.alloc(aBuf.length);
  Buffer.from(b).copy(bBuf);
  const equal = timingSafeEqual(aBuf, bBuf);
  return equal && a.length === b.length;
}

export function extractBearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  const query = (req.query as Record<string, string | undefined>)["token"];
  return query ?? null;
}

export function buildAuthPreHandler(token: string) {
  return async function authPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const provided = extractBearerToken(req);
    if (!provided || !constantTimeEqual(provided, token)) {
      const err = new EngineError("unauthorized", "Missing or invalid token");
      await reply.status(err.status).send(err.toJSON());
      return;
    }
  };
}
