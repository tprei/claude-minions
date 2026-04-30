import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import type { EngineContext } from "../context.js";
import { isEngineError } from "../errors.js";
import { registerSessionsRoutes } from "./routes.js";
import type { Session, SessionMode, TranscriptEvent } from "@minions/shared";

const TRANSPARENT_PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

interface BuildOpts {
  screenshotsRoot: string;
  sessionExists?: boolean;
  screenshotPathOverride?: (slug: string, filename: string) => string;
}

function buildApp(opts: BuildOpts): FastifyInstance {
  const app = Fastify({ logger: false });
  app.setErrorHandler(async (err, _req, reply) => {
    if (isEngineError(err)) {
      await reply.status(err.status).send(err.toJSON());
      return;
    }
    await reply.status(500).send({ error: "internal", message: (err as Error).message });
  });
  const ctx = {
    sessions: {
      get: (slug: string) =>
        opts.sessionExists === false ? null : ({ slug } as unknown as import("@minions/shared").Session),
      screenshotPath:
        opts.screenshotPathOverride ??
        ((slug: string, filename: string) => path.join(opts.screenshotsRoot, slug, filename)),
    },
    github: { enabled: () => false, fetchPR: async () => ({}) },
    readiness: { compute: async () => ({}) },
  } as unknown as EngineContext;
  registerSessionsRoutes(app, ctx);
  return app;
}

describe("GET /api/sessions/:slug/screenshots/:filename", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routes-screenshot-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns JSON 404 (not a FastifyError crash) when the file is missing", async () => {
    const app = buildApp({ screenshotsRoot: tmpRoot });
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/abc/screenshots/missing.png",
    });
    assert.equal(res.statusCode, 404);
    const ct = res.headers["content-type"]?.toString() ?? "";
    assert.ok(ct.includes("application/json"), `expected JSON content-type, got ${ct}`);
    const body = res.json() as { error: string; message: string };
    assert.equal(body.error, "not_found");
    assert.match(body.message, /screenshot/i);
    await app.close();
  });

  it("returns JSON 500 (not a FastifyError crash) when the path is unreadable", async () => {
    const app = buildApp({
      screenshotsRoot: tmpRoot,
      screenshotPathOverride: () => path.join(tmpRoot, "nope-dir", "x", "file.png"),
    });
    fs.writeFileSync(path.join(tmpRoot, "nope-dir"), "blocking file");
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/abc/screenshots/file.png",
    });
    assert.ok(res.statusCode === 404 || res.statusCode === 500, `unexpected status ${res.statusCode}`);
    const ct = res.headers["content-type"]?.toString() ?? "";
    assert.ok(ct.includes("application/json"), `expected JSON content-type, got ${ct}`);
    const body = res.json() as { error: string; message: string };
    assert.ok(body.error === "internal" || body.error === "not_found");
    assert.equal(typeof body.message, "string");
    await app.close();
  });

  it("streams the PNG payload when the file exists", async () => {
    const slugDir = path.join(tmpRoot, "abc");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "ok.png"), TRANSPARENT_PNG_1X1);

    const app = buildApp({ screenshotsRoot: tmpRoot });
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/abc/screenshots/ok.png",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "image/png");
    assert.deepEqual(res.rawPayload, TRANSPARENT_PNG_1X1);
    await app.close();
  });

  it("returns 404 JSON when the session does not exist", async () => {
    const app = buildApp({ screenshotsRoot: tmpRoot, sessionExists: false });
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/missing/screenshots/whatever.png",
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error: string };
    assert.equal(body.error, "not_found");
    await app.close();
  });

  it("returns 400 JSON for path-traversal filenames", async () => {
    const app = buildApp({ screenshotsRoot: tmpRoot });
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/abc/screenshots/..hidden",
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string };
    assert.equal(body.error, "bad_request");
    await app.close();
  });
});

interface PlanBuildOpts {
  sessions: Map<string, { mode: SessionMode }>;
  transcript?: (slug: string) => TranscriptEvent[];
}

function buildPlanApp(opts: PlanBuildOpts): FastifyInstance {
  const app = Fastify({ logger: false });
  app.setErrorHandler(async (err, _req, reply) => {
    if (isEngineError(err)) {
      await reply.status(err.status).send(err.toJSON());
      return;
    }
    await reply.status(500).send({ error: "internal", message: (err as Error).message });
  });
  const ctx = {
    sessions: {
      get: (slug: string): Session | null => {
        const s = opts.sessions.get(slug);
        return s ? ({ slug, mode: s.mode } as unknown as Session) : null;
      },
      transcript: (slug: string): TranscriptEvent[] =>
        opts.transcript ? opts.transcript(slug) : [],
    },
    github: { enabled: () => false, fetchPR: async () => ({}) },
    readiness: { compute: async () => ({}) },
  } as unknown as EngineContext;
  registerSessionsRoutes(app, ctx);
  return app;
}

describe("GET /api/sessions/:slug/plan", () => {
  it("returns 200 with { plan, source } for a think session", async () => {
    const longText = "x".repeat(250);
    const app = buildPlanApp({
      sessions: new Map([["t1", { mode: "think" }]]),
      transcript: () => [
        {
          id: "evt-1",
          sessionSlug: "t1",
          seq: 1,
          turn: 0,
          timestamp: "2026-01-01T00:00:00Z",
          kind: "assistant_text",
          text: longText,
        },
      ],
    });
    const res = await app.inject({ method: "GET", url: "/api/sessions/t1/plan" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { plan: string; source: string };
    assert.equal(body.plan, longText);
    assert.equal(body.source, "transcript");
    await app.close();
  });

  it("returns 400 when the session is not in think mode", async () => {
    const app = buildPlanApp({
      sessions: new Map([["s1", { mode: "ship" }]]),
    });
    const res = await app.inject({ method: "GET", url: "/api/sessions/s1/plan" });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string };
    assert.equal(body.error, "bad_request");
    await app.close();
  });

  it("returns 404 when the session does not exist", async () => {
    const app = buildPlanApp({ sessions: new Map() });
    const res = await app.inject({ method: "GET", url: "/api/sessions/missing/plan" });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error: string };
    assert.equal(body.error, "not_found");
    await app.close();
  });
});
