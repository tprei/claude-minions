import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import { EngineError } from "../../errors.js";

interface MessageRequest {
  sessionSlug?: string;
  prompt: string;
  mode?: string;
  repoId?: string;
  baseBranch?: string;
  modelHint?: string;
  attachments?: { name: string; mimeType: string; dataBase64: string }[];
  metadata?: Record<string, unknown>;
}

export function registerMessageRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.post("/api/messages", async (req, reply) => {
    const body = req.body as MessageRequest | undefined;
    if (!body || typeof body !== "object") {
      throw new EngineError("bad_request", "Request body must be an object");
    }
    if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
      throw new EngineError("bad_request", "prompt is required");
    }

    if (body.sessionSlug) {
      await ctx.sessions.reply(body.sessionSlug, body.prompt);
      const session = ctx.sessions.get(body.sessionSlug);
      await reply.send({ ok: true, session });
      return;
    }

    const session = await ctx.sessions.create({
      prompt: body.prompt,
      mode: body.mode as "task" | undefined,
      repoId: body.repoId,
      baseBranch: body.baseBranch,
      modelHint: body.modelHint,
      attachments: body.attachments,
      metadata: body.metadata,
    });
    await reply.status(201).send(session);
  });
}
