import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Memory, MemoryReviewCommand } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import { EngineError, isEngineError } from "../../errors.js";
import { registerMemoryRoutes } from "./memories.js";

interface ReviewCall {
  id: string;
  cmd: MemoryReviewCommand;
}

function fakeMemory(id: string): Memory {
  return {
    id,
    kind: "user",
    status: "approved",
    scope: "global",
    pinned: false,
    title: "t",
    body: "b",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  };
}

describe("PATCH /api/memories/:id/review", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let calls: ReviewCall[];

  before(async () => {
    calls = [];
    const ctx = {
      memory: {
        list: () => [],
        get: () => null,
        create: async () => fakeMemory("created"),
        update: async (id: string) => fakeMemory(id),
        review: async (id: string, cmd: MemoryReviewCommand) => {
          calls.push({ id, cmd });
          return fakeMemory(id);
        },
        delete: async () => {},
        renderPreamble: () => "",
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
    registerMemoryRoutes(app, ctx);
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
    calls.length = 0;
  });

  async function patchReview(body: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}/api/memories/m1/review`, {
      method: "PATCH",
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

  it("accepts {decision:'approve'} and forwards exactly that to memory.review", async () => {
    const res = await patchReview({ decision: "approve" });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { id: "m1", cmd: { decision: "approve" } });
  });

  it("accepts {decision:'approve', reason:'good'}", async () => {
    const res = await patchReview({ decision: "approve", reason: "good" });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.cmd, { decision: "approve", reason: "good" });
  });

  it("rejects empty body with 400", async () => {
    const res = await patchReview({});
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  it("rejects bad decision value with 400", async () => {
    const res = await patchReview({ decision: "yes" });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  it("rejects unknown fields with 400", async () => {
    const res = await patchReview({ decision: "approve", evil: "hi" });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  it("rejects wrong-typed reason with 400", async () => {
    const res = await patchReview({ decision: "approve", reason: 123 });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });
});
