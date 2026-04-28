import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../context.js";
import { EngineError } from "../errors.js";
import { serveMcpStdio } from "./mcpServer.js";

interface McpRouteBody {
  line?: unknown;
}

export function registerMcpRoute(app: FastifyInstance, ctx: EngineContext): void {
  app.post("/api/mcp/:sessionSlug", async (req, reply) => {
    const { sessionSlug } = req.params as { sessionSlug: string };

    const session = ctx.sessions.get(sessionSlug);
    if (!session) {
      throw new EngineError("not_found", `Session ${sessionSlug} not found`);
    }

    const body = (req.body ?? {}) as McpRouteBody;
    if (typeof body.line !== "string") {
      throw new EngineError("bad_request", "line must be a string");
    }

    const handle = serveMcpStdio(sessionSlug, ctx);
    const responseLine = handle.handleLine(body.line);
    await reply.send({ line: responseLine ?? "" });
  });
}
