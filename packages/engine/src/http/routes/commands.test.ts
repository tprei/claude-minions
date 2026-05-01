import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import type { AttentionFlag, Session } from "@minions/shared";
import { isEngineError } from "../../errors.js";
import { migrations } from "../../store/migrations.js";
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

describe("POST /api/commands open-for-review", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let openForReviewCalls: string[];

  before(async () => {
    openForReviewCalls = [];
    const ctx = {
      landing: {
        openForReview: async (slug: string) => {
          openForReviewCalls.push(slug);
          return null;
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
    openForReviewCalls.length = 0;
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

  it("forwards a valid open-for-review to ctx.landing.openForReview", async () => {
    const res = await postCommand({ kind: "open-for-review", sessionSlug: "stuck-session" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.deepEqual(openForReviewCalls, ["stuck-session"]);
  });

  it("rejects open-for-review without sessionSlug with 400", async () => {
    const res = await postCommand({ kind: "open-for-review" });
    assert.equal(res.status, 400);
    assert.deepEqual((res.body as { error?: string }).error, "bad_request");
    assert.equal(openForReviewCalls.length, 0);
  });
});

describe("POST /api/commands update-session-budget", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let db: Database.Database;
  let kickCalls: string[];
  let auditCalls: Array<{ actor: string; action: string; target?: { kind: string; id: string }; detail?: Record<string, unknown> }>;
  let busEvents: Array<{ kind: string; session?: Session }>;

  function seedSession(slug: string, attention: AttentionFlag[], costBudgetUsd: number | null = null): void {
    db.prepare(
      `INSERT INTO sessions(
        slug, title, prompt, mode, status, attention, quick_actions,
        stats_turns, stats_input_tokens, stats_output_tokens, stats_cache_read_tokens,
        stats_cache_creation_tokens, stats_cost_usd, stats_duration_ms, stats_tool_calls,
        provider, created_at, updated_at, metadata, cost_budget_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      slug, "title", "prompt", "task", "waiting_input",
      JSON.stringify(attention), JSON.stringify([]),
      0, 0, 0, 0, 0, 0, 0, 0,
      "test", new Date().toISOString(), new Date().toISOString(), JSON.stringify({}),
      costBudgetUsd,
    );
  }

  function getRow(slug: string): { cost_budget_usd: number | null; attention: string } {
    return db.prepare(`SELECT cost_budget_usd, attention FROM sessions WHERE slug = ?`).get(slug) as {
      cost_budget_usd: number | null;
      attention: string;
    };
  }

  before(async () => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    for (const m of migrations) db.exec(m.sql);

    kickCalls = [];
    auditCalls = [];
    busEvents = [];

    const ctx = {
      db,
      sessions: {
        get: (slug: string) => {
          const row = db.prepare(`SELECT slug, attention, cost_budget_usd FROM sessions WHERE slug = ?`).get(slug) as
            | { slug: string; attention: string; cost_budget_usd: number | null }
            | undefined;
          if (!row) return null;
          return {
            slug: row.slug,
            attention: JSON.parse(row.attention) as AttentionFlag[],
            costBudgetUsd: row.cost_budget_usd ?? undefined,
          } as unknown as Session;
        },
        kickReplyQueue: async (slug: string) => {
          kickCalls.push(slug);
          return true;
        },
      },
      bus: {
        emit: (ev: { kind: string; session?: Session }) => {
          busEvents.push(ev);
        },
      },
      audit: {
        record: (actor: string, action: string, target?: { kind: string; id: string }, detail?: Record<string, unknown>) => {
          auditCalls.push({ actor, action, target, detail });
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
    db.close();
  });

  beforeEach(() => {
    db.prepare(`DELETE FROM sessions`).run();
    kickCalls.length = 0;
    auditCalls.length = 0;
    busEvents.length = 0;
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

  it("clears budget_exceeded attention, updates the column, and re-kicks the queue", async () => {
    const raisedAt = new Date().toISOString();
    seedSession(
      "abc",
      [
        { kind: "budget_exceeded", message: "Cost cap reached", raisedAt },
        { kind: "needs_input", message: "needs input", raisedAt },
      ],
      2,
    );

    const res = await postCommand({
      kind: "update-session-budget",
      slug: "abc",
      costBudgetUsd: 7.5,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, data: { kicked: true } });

    const row = getRow("abc");
    assert.equal(row.cost_budget_usd, 7.5);
    const remaining = JSON.parse(row.attention) as AttentionFlag[];
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.kind, "needs_input");

    assert.deepEqual(kickCalls, ["abc"]);
    assert.equal(busEvents.some((e) => e.kind === "session_updated"), true);
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0]!.action, "session.budget.updated");
    assert.deepEqual(auditCalls[0]!.detail, { costBudgetUsd: 7.5 });
  });

  it("treats costBudgetUsd of 0 as clearing the cap", async () => {
    seedSession("zero", [], 5);
    const res = await postCommand({
      kind: "update-session-budget",
      slug: "zero",
      costBudgetUsd: 0,
    });
    assert.equal(res.status, 200);
    const row = getRow("zero");
    assert.equal(row.cost_budget_usd, null);
  });

  it("returns 404 when session does not exist", async () => {
    const res = await postCommand({
      kind: "update-session-budget",
      slug: "missing",
      costBudgetUsd: 1,
    });
    assert.equal(res.status, 404);
    assert.equal(kickCalls.length, 0);
  });

  it("rejects negative costBudgetUsd with 400", async () => {
    seedSession("neg", []);
    const res = await postCommand({
      kind: "update-session-budget",
      slug: "neg",
      costBudgetUsd: -1,
    });
    assert.equal(res.status, 400);
    assert.equal(kickCalls.length, 0);
  });

  it("rejects non-numeric costBudgetUsd with 400", async () => {
    seedSession("nan", []);
    const res = await postCommand({
      kind: "update-session-budget",
      slug: "nan",
      costBudgetUsd: "lots",
    });
    assert.equal(res.status, 400);
    assert.equal(kickCalls.length, 0);
  });
});

describe("POST /api/commands retry", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let replyCalls: Array<{ slug: string; text: string }>;
  let kickCalls: string[];

  before(async () => {
    replyCalls = [];
    kickCalls = [];
    const ctx = {
      sessions: {
        reply: async (slug: string, text: string) => {
          replyCalls.push({ slug, text });
        },
        kickReplyQueue: async (slug: string) => {
          kickCalls.push(slug);
          return true;
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
    replyCalls.length = 0;
    kickCalls.length = 0;
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

  it("retry queues a reply AND kicks the reply queue so the session actually wakes", async () => {
    const res = await postCommand({ kind: "retry", sessionSlug: "sess-r" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, data: { kicked: true } });
    assert.deepEqual(replyCalls, [{ slug: "sess-r", text: "Please retry." }]);
    assert.deepEqual(kickCalls, ["sess-r"]);
  });
});

describe("POST /api/commands stack land-all", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let db: Database.Database;
  let auditActions: string[];

  before(async () => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    for (const m of migrations) db.exec(m.sql);

    auditActions = [];
    const sessions = new Map<string, Session>([
      [
        "ship-1",
        {
          slug: "ship-1",
          title: "ship session",
          prompt: "do work",
          mode: "ship",
          status: "completed",
          attention: [],
          quickActions: [],
          stats: {
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0,
            durationMs: 0,
            toolCalls: 0,
          },
          provider: "mock",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          childSlugs: [],
          metadata: {},
        } as Session,
      ],
    ]);
    const dags = [
      {
        id: "dag-bound",
        rootSessionSlug: "ship-1",
        nodes: [],
      },
      {
        id: "dag-other",
        rootSessionSlug: "some-other-ship",
        nodes: [],
      },
    ];
    const ctx = {
      db,
      sessions: {
        get: (slug: string) => sessions.get(slug) ?? null,
      },
      dags: {
        list: () => dags,
      },
      audit: {
        record: (_actor: string, action: string) => {
          auditActions.push(action);
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
    db.close();
  });

  beforeEach(() => {
    auditActions.length = 0;
    db.prepare("DELETE FROM automation_jobs WHERE kind = 'stack-land'").run();
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

  it("enqueues a stack-land automation job for the DAG bound to the ship session", async () => {
    const res = await postCommand({
      kind: "stack",
      sessionSlug: "ship-1",
      action: "land-all",
    });
    assert.equal(res.status, 200);
    const data = (res.body as { ok: boolean; data: { dagId: string; jobId: string } }).data;
    assert.equal(data.dagId, "dag-bound");
    assert.ok(data.jobId, "jobId returned");
    const rows = db
      .prepare("SELECT kind, target_kind, target_id, status FROM automation_jobs WHERE kind = 'stack-land'")
      .all() as Array<{ kind: string; target_kind: string; target_id: string; status: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.target_id, "dag-bound");
    assert.equal(rows[0]!.status, "pending");
    assert.ok(auditActions.includes("stack:land-all"));
  });

  it("returns 409 when the session has no bound DAG", async () => {
    const res = await postCommand({
      kind: "stack",
      sessionSlug: "ship-1",
      action: "land-all",
    });
    assert.equal(res.status, 200, "first call succeeds with bound DAG");
    db.prepare("DELETE FROM automation_jobs WHERE kind = 'stack-land'").run();

    const noDagCtx = await fetch(`${baseUrl}/api/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "stack",
        sessionSlug: "session-with-no-dag",
        action: "land-all",
      }),
    });
    assert.equal(noDagCtx.status, 404, "missing session → 404 not_found");
  });

  it("returns 404 when the session does not exist", async () => {
    const res = await postCommand({
      kind: "stack",
      sessionSlug: "ghost-session",
      action: "land-all",
    });
    assert.equal(res.status, 404);
    const rows = db
      .prepare("SELECT count(*) as c FROM automation_jobs WHERE kind = 'stack-land'")
      .get() as { c: number };
    assert.equal(rows.c, 0, "no job enqueued for missing session");
  });

  it("non-land-all action remains a no-op show", async () => {
    const res = await postCommand({
      kind: "stack",
      sessionSlug: "ship-1",
      action: "show",
    });
    assert.equal(res.status, 200);
    const rows = db
      .prepare("SELECT count(*) as c FROM automation_jobs WHERE kind = 'stack-land'")
      .get() as { c: number };
    assert.equal(rows.c, 0, "no stack-land job enqueued for show action");
  });
});
