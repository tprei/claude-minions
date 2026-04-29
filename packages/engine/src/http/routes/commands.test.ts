import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import { isEngineError } from "../../errors.js";
import { registerCommandRoutes } from "./commands.js";

describe("POST /api/commands resume-session", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let kickCalls: string[];
  let kickResult: boolean;

  before(async () => {
    kickCalls = [];
    kickResult = true;
    const ctx = {
      sessions: {
        kickReplyQueue: async (slug: string) => {
          kickCalls.push(slug);
          return kickResult;
        },
      },
    } as unknown as EngineContext;

    app = Fastify({ logger: false });
    app.setErrorHandler(async (err, _req, reply) => {
      if (isEngineError(err)) {
        await reply.status(err.status).send(err.toJSON());
        return;
      }
      const e = err as Error;
      await reply.status(500).send({ error: "internal", message: e.message });
    });
    registerCommandRoutes(app, ctx);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Fastify did not return a network address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await app.close();
  });

  beforeEach(() => {
    kickCalls.length = 0;
    kickResult = true;
  });

  async function postCommand(body: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}/api/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // keep raw text
      }
    }
    return { status: res.status, body: parsed };
  }

  it("forwards a valid resume-session to ctx.sessions.kickReplyQueue and returns kicked=true", async () => {
    const res = await postCommand({ kind: "resume-session", sessionSlug: "abc-123" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, data: { kicked: true } });
    assert.deepEqual(kickCalls, ["abc-123"]);
  });

  it("returns kicked=false when kickReplyQueue declines", async () => {
    kickResult = false;
    const res = await postCommand({ kind: "resume-session", sessionSlug: "already-running" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, data: { kicked: false } });
    assert.deepEqual(kickCalls, ["already-running"]);
  });

  it("rejects resume-session without sessionSlug with 400", async () => {
    const res = await postCommand({ kind: "resume-session" });
    assert.equal(res.status, 400);
    assert.equal(kickCalls.length, 0);
  });

  it("rejects resume-session with empty sessionSlug with 400", async () => {
    const res = await postCommand({ kind: "resume-session", sessionSlug: "  " });
    assert.equal(res.status, 400);
    assert.equal(kickCalls.length, 0);
  });
});
