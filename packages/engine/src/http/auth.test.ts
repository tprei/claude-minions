import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { buildAuthPreHandler, extractBearerToken, type RouteAuthMode } from "./auth.js";

const TOKEN = "correct-token";

describe("extractBearerToken", () => {
  it("extracts token from Authorization header in any mode", () => {
    for (const mode of ["public", "header", "query-token"] as RouteAuthMode[]) {
      const req = {
        headers: { authorization: "Bearer mysecret" },
        query: {},
      } as unknown as Parameters<typeof extractBearerToken>[0];
      assert.equal(extractBearerToken(req, mode), "mysecret");
    }
  });

  it("ignores ?token= in default (header) mode", () => {
    const req = {
      headers: {},
      query: { token: "querytoken" },
    } as unknown as Parameters<typeof extractBearerToken>[0];
    assert.equal(extractBearerToken(req), null);
    assert.equal(extractBearerToken(req, "header"), null);
  });

  it("accepts ?token= only when mode is query-token", () => {
    const req = {
      headers: {},
      query: { token: "querytoken" },
    } as unknown as Parameters<typeof extractBearerToken>[0];
    assert.equal(extractBearerToken(req, "query-token"), "querytoken");
  });

  it("returns null when neither header nor query present", () => {
    const req = {
      headers: {},
      query: {},
    } as unknown as Parameters<typeof extractBearerToken>[0];
    assert.equal(extractBearerToken(req, "header"), null);
    assert.equal(extractBearerToken(req, "query-token"), null);
  });

  it("returns null for non-Bearer authorization", () => {
    const req = {
      headers: { authorization: "Basic abc" },
      query: {},
    } as unknown as Parameters<typeof extractBearerToken>[0];
    assert.equal(extractBearerToken(req, "header"), null);
  });
});

async function buildAuthMatrixApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const authPreHandler = buildAuthPreHandler(TOKEN);
  app.addHook("preHandler", async (req, reply) => {
    const url = req.url.split("?")[0] ?? "";
    if (!url.startsWith("/api/")) return;
    await authPreHandler(req, reply);
  });

  app.get("/api/public-thing", { config: { auth: "public" } }, async (_req, reply) => {
    return reply.send({ ok: true, mode: "public" });
  });
  app.get("/api/header-thing", { config: { auth: "header" } }, async (_req, reply) => {
    return reply.send({ ok: true, mode: "header" });
  });
  app.get("/api/sse-thing", { config: { auth: "query-token" } }, async (_req, reply) => {
    return reply.send({ ok: true, mode: "query-token" });
  });
  app.get("/api/unmarked-thing", async (_req, reply) => {
    return reply.send({ ok: true, mode: "unmarked" });
  });

  await app.ready();
  return app;
}

type AuthAttempt = "none" | "header" | "query-token";

interface MatrixCase {
  url: string;
  expectedMode: RouteAuthMode | "unmarked-default-header";
  expected: Record<AuthAttempt, number>;
}

const MATRIX: MatrixCase[] = [
  {
    url: "/api/public-thing",
    expectedMode: "public",
    expected: { none: 200, header: 200, "query-token": 200 },
  },
  {
    url: "/api/header-thing",
    expectedMode: "header",
    expected: { none: 401, header: 200, "query-token": 401 },
  },
  {
    url: "/api/sse-thing",
    expectedMode: "query-token",
    expected: { none: 401, header: 200, "query-token": 200 },
  },
  {
    url: "/api/unmarked-thing",
    expectedMode: "unmarked-default-header",
    expected: { none: 401, header: 200, "query-token": 401 },
  },
];

function attemptHeaders(attempt: AuthAttempt): Record<string, string> {
  return attempt === "header" ? { authorization: `Bearer ${TOKEN}` } : {};
}

function attemptUrl(base: string, attempt: AuthAttempt): string {
  return attempt === "query-token" ? `${base}?token=${encodeURIComponent(TOKEN)}` : base;
}

describe("auth preHandler matrix", () => {
  for (const c of MATRIX) {
    for (const attempt of ["none", "header", "query-token"] as AuthAttempt[]) {
      it(`${c.url} (${c.expectedMode}) with ${attempt} auth → ${c.expected[attempt]}`, async () => {
        const app = await buildAuthMatrixApp();
        try {
          const res = await app.inject({
            method: "GET",
            url: attemptUrl(c.url, attempt),
            headers: attemptHeaders(attempt),
          });
          assert.equal(res.statusCode, c.expected[attempt]);
        } finally {
          await app.close();
        }
      });
    }
  }
});

describe("auth preHandler default-deny", () => {
  it("a new route registered without { config: { auth } } is treated as header-only", async () => {
    const app = Fastify({ logger: false });
    const authPreHandler = buildAuthPreHandler(TOKEN);
    app.addHook("preHandler", async (req, reply) => {
      const url = req.url.split("?")[0] ?? "";
      if (!url.startsWith("/api/")) return;
      await authPreHandler(req, reply);
    });

    app.get("/api/brand-new-route", async (_req, reply) => {
      return reply.send({ ok: true });
    });
    await app.ready();

    try {
      const noAuth = await app.inject({ method: "GET", url: "/api/brand-new-route" });
      assert.equal(noAuth.statusCode, 401, "unmarked route must reject unauthenticated requests");

      const queryOnly = await app.inject({
        method: "GET",
        url: `/api/brand-new-route?token=${encodeURIComponent(TOKEN)}`,
      });
      assert.equal(
        queryOnly.statusCode,
        401,
        "unmarked route must NOT accept ?token= (query-token must be opt-in)",
      );

      const withHeader = await app.inject({
        method: "GET",
        url: "/api/brand-new-route",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(withHeader.statusCode, 200, "unmarked route accepts valid header bearer");
    } finally {
      await app.close();
    }
  });
});

describe("auth preHandler error response", () => {
  it("returns the canonical 401 envelope on auth failure", async () => {
    const app = await buildAuthMatrixApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/header-thing" });
      assert.equal(res.statusCode, 401);
      const body = res.json() as { error?: string };
      assert.equal(body.error, "unauthorized");
    } finally {
      await app.close();
    }
  });
});
