import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import type { DAG } from "@minions/shared";
import type { EngineContext } from "../context.js";
import { EngineError, isEngineError } from "../errors.js";
import { registerDagRoutes } from "./routes.js";

interface RetryCall {
  dagId: string;
  nodeId: string;
}

function makeDag(id: string): DAG {
  return {
    id,
    title: "t",
    goal: "g",
    status: "active",
    nodes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    repoId: "repo-x",
    baseBranch: "main",
    rootSessionSlug: null,
  } as unknown as DAG;
}

function buildApp(stub: {
  retry?: (dagId: string, nodeId: string) => Promise<void>;
  get?: (id: string) => DAG | null;
  retries?: RetryCall[];
}): FastifyInstance {
  const app = Fastify({ logger: false });
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
  app.setErrorHandler(async (err, _req, reply) => {
    if (isEngineError(err)) {
      await reply.status(err.status).send(err.toJSON());
      return;
    }
    await reply.status(500).send({ error: "internal", message: (err as Error).message });
  });
  const ctx = {
    dags: {
      list: () => [],
      get: stub.get ?? ((id: string) => makeDag(id)),
      retry:
        stub.retry ??
        (async (dagId: string, nodeId: string) => {
          stub.retries?.push({ dagId, nodeId });
        }),
    },
  } as unknown as EngineContext;
  registerDagRoutes(app, ctx);
  return app;
}

describe("registerDagRoutes retry route", () => {
  it("POST /api/dags/:dagId/nodes/:nodeId/retry returns the updated DAG (no 404)", async () => {
    const retries: RetryCall[] = [];
    const app = buildApp({ retries });
    const res = await app.inject({
      method: "POST",
      url: "/api/dags/dag-1/nodes/node-1/retry",
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(retries, [{ dagId: "dag-1", nodeId: "node-1" }]);
    const body = res.json() as DAG;
    assert.equal(body.id, "dag-1");
    await app.close();
  });

  it("accepts empty body (no payload)", async () => {
    const retries: RetryCall[] = [];
    const app = buildApp({ retries });
    const res = await app.inject({
      method: "POST",
      url: "/api/dags/dag-2/nodes/node-9/retry",
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(retries, [{ dagId: "dag-2", nodeId: "node-9" }]);
    await app.close();
  });

  it("accepts empty body with Content-Type: application/json (no FST_ERR_CTP_EMPTY_JSON_BODY)", async () => {
    const retries: RetryCall[] = [];
    const app = buildApp({ retries });
    const res = await app.inject({
      method: "POST",
      url: "/api/dags/dag-3/nodes/node-3/retry",
      headers: { "content-type": "application/json" },
      payload: "",
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(retries, [{ dagId: "dag-3", nodeId: "node-3" }]);
    await app.close();
  });

  it("propagates EngineError status from ctx.dags.retry", async () => {
    const app = buildApp({
      retry: async () => {
        throw new EngineError("not_found", "dag not found: missing");
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/dags/missing/nodes/n1/retry",
      payload: {},
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  });
});
