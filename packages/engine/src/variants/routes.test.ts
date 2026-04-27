import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import type { CreateVariantsRequest } from "@minions/shared";
import type { EngineContext } from "../context.js";
import { isEngineError } from "../errors.js";
import { registerVariantsRoutes } from "./routes.js";

interface StubResult {
  parentSlug: string;
  childSlugs: string[];
}

function buildApp(stub: {
  spawn: (req: CreateVariantsRequest) => Promise<StubResult>;
}): FastifyInstance {
  const app = Fastify({ logger: false });
  app.setErrorHandler(async (err, _req, reply) => {
    if (isEngineError(err)) {
      await reply.status(err.status).send(err.toJSON());
      return;
    }
    await reply.status(500).send({ error: "internal", message: (err as Error).message });
  });
  const ctx = {
    variants: {
      spawn: stub.spawn,
      judge: async () => {},
    },
  } as unknown as EngineContext;
  registerVariantsRoutes(app, ctx);
  return app;
}

describe("registerVariantsRoutes", () => {
  it("returns 201 with parentSlug + childSlugs on valid request", async () => {
    const expected: StubResult = {
      parentSlug: "parent-abc",
      childSlugs: ["child-1", "child-2", "child-3"],
    };
    const app = buildApp({ spawn: async () => expected });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/variants",
      payload: { prompt: "x", count: 3 },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json() as StubResult;
    assert.deepEqual(body, expected);
    await app.close();
  });

  it("forwards optional fields to ctx.variants.spawn", async () => {
    let captured: CreateVariantsRequest | null = null;
    const app = buildApp({
      spawn: async (req) => {
        captured = req;
        return { parentSlug: "p", childSlugs: ["c"] };
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/variants",
      payload: {
        prompt: "x",
        count: 1,
        repoId: "r",
        baseBranch: "main",
        modelHint: "m",
        judgeRubric: "rubric",
      },
    });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(captured, {
      prompt: "x",
      count: 1,
      repoId: "r",
      baseBranch: "main",
      modelHint: "m",
      judgeRubric: "rubric",
    });
    await app.close();
  });

  it("rejects missing prompt with 400", async () => {
    const app = buildApp({ spawn: async () => ({ parentSlug: "p", childSlugs: [] }) });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/variants",
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: string }).error, "bad_request");
    await app.close();
  });

  it("rejects count = 0 with 400", async () => {
    const app = buildApp({ spawn: async () => ({ parentSlug: "p", childSlugs: [] }) });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/variants",
      payload: { prompt: "x", count: 0 },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  it("rejects count = 11 with 400", async () => {
    const app = buildApp({ spawn: async () => ({ parentSlug: "p", childSlugs: [] }) });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/variants",
      payload: { prompt: "x", count: 11 },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  it("rejects unknown fields with 400", async () => {
    const app = buildApp({ spawn: async () => ({ parentSlug: "p", childSlugs: [] }) });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/variants",
      payload: { prompt: "x", count: 2, evil: "hi" },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string; message: string };
    assert.equal(body.error, "bad_request");
    assert.match(body.message, /unknown field: evil/);
    await app.close();
  });

  it("rejects wrong-typed count with 400", async () => {
    const app = buildApp({ spawn: async () => ({ parentSlug: "p", childSlugs: [] }) });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/variants",
      payload: { prompt: "x", count: "two" },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });
});
