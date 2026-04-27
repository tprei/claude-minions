import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { migrations } from "../store/migrations.js";
import { isEngineError } from "../errors.js";
import { registerSessionsRoutes } from "./routes.js";
import { rowToTranscriptEvent, type TranscriptRow } from "./mapper.js";
import type { EngineContext } from "../context.js";
import type { TranscriptEvent } from "@minions/shared";

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) {
    db.exec(m.sql);
  }
  return db;
}

function insertSession(db: Database.Database, slug: string): void {
  db.prepare(`
    INSERT INTO sessions(
      slug, title, prompt, mode, status, attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens,
      stats_cache_read_tokens, stats_cache_creation_tokens,
      stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, created_at, updated_at, pr_draft, metadata
    ) VALUES (
      ?, ?, ?, 'task', 'running', '[]', '[]',
      0, 0, 0, 0, 0, 0, 0, 0, 'mock', datetime('now'), datetime('now'), 0, '{}'
    )
  `).run(slug, "Test", "test prompt");
}

function insertEvent(db: Database.Database, slug: string, seq: number): void {
  db.prepare(`
    INSERT INTO transcript_events(id, session_slug, seq, turn, kind, body, timestamp)
    VALUES (?, ?, ?, 0, 'assistant_text', ?, datetime('now'))
  `).run(`evt-${slug}-${seq}`, slug, seq, JSON.stringify({ text: `msg-${seq}` }));
}

function buildCtx(db: Database.Database): EngineContext {
  const ctx = {
    sessions: {
      get(slug: string) {
        const row = db.prepare(`SELECT slug FROM sessions WHERE slug = ?`).get(slug) as { slug: string } | undefined;
        return row ? ({ slug: row.slug } as unknown as ReturnType<EngineContext["sessions"]["get"]>) : null;
      },
      transcript(slug: string, sinceSeq?: number): TranscriptEvent[] {
        const rows = sinceSeq === undefined
          ? (db.prepare(`SELECT * FROM transcript_events WHERE session_slug = ? ORDER BY seq ASC`).all(slug) as TranscriptRow[])
          : (db.prepare(`SELECT * FROM transcript_events WHERE session_slug = ? AND seq > ? ORDER BY seq ASC`).all(slug, sinceSeq) as TranscriptRow[]);
        return rows.map(rowToTranscriptEvent);
      },
    },
  } as unknown as EngineContext;
  return ctx;
}

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler(async (err, _req, reply) => {
    if (isEngineError(err)) {
      await reply.status(err.status).send(err.toJSON());
      return;
    }
    await reply.status(500).send({ error: "internal", message: (err as Error).message });
  });
  registerSessionsRoutes(app, buildCtx(db));
  await app.ready();
  return app;
}

describe("GET /api/sessions/:slug/transcript ?since=", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  const slug = "sess-since";

  beforeEach(async () => {
    db = makeInMemoryDb();
    insertSession(db, slug);
    for (let seq = 0; seq < 5; seq++) {
      insertEvent(db, slug, seq);
    }
    app = await buildApp(db);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  test("without ?since returns all 5 events", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${slug}/transcript` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { items: TranscriptEvent[] };
    assert.equal(body.items.length, 5);
    assert.deepEqual(body.items.map((e) => e.seq), [0, 1, 2, 3, 4]);
  });

  test("?since=2 returns events with seq 3 and 4", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${slug}/transcript?since=2` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { items: TranscriptEvent[] };
    assert.deepEqual(body.items.map((e) => e.seq), [3, 4]);
  });

  test("?since=4 returns empty list", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${slug}/transcript?since=4` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { items: TranscriptEvent[] };
    assert.equal(body.items.length, 0);
  });

  test("?since=abc returns 400", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${slug}/transcript?since=abc` });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string };
    assert.equal(body.error, "bad_request");
  });

  test("?since=-1 returns 400", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${slug}/transcript?since=-1` });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string };
    assert.equal(body.error, "bad_request");
  });
});
