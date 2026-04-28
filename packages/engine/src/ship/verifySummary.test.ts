import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";
import type { DAG, MergeReadiness, Session, StatusEvent } from "@minions/shared";
import type { EngineContext } from "../context.js";
import { EventBus } from "../bus/eventBus.js";
import { KeyedMutex } from "../util/mutex.js";
import { createLogger } from "../logger.js";
import { openStore } from "../store/sqlite.js";
import { ShipCoordinator } from "./coordinator.js";

function makeTempDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-verify-summary-"));
  return openStore({ path: path.join(dir, "engine.db"), log: createLogger("error") });
}

function makeShipSession(slug: string): Session {
  const now = new Date().toISOString();
  return {
    slug,
    title: "Ship verify test",
    prompt: "ship X",
    mode: "ship",
    status: "running",
    shipStage: "verify",
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
    createdAt: now,
    updatedAt: now,
    childSlugs: [],
    metadata: {},
  };
}

function insertSession(db: Database.Database, session: Session): void {
  db.prepare(`
    INSERT INTO sessions(
      slug, title, prompt, mode, status, ship_stage, repo_id, branch, base_branch,
      worktree_path, parent_slug, root_slug, pr_number, pr_url, pr_state, pr_draft,
      pr_base, pr_head, pr_title, attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens, stats_cache_read_tokens,
      stats_cache_creation_tokens, stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, model_hint, created_at, updated_at, started_at, completed_at,
      last_turn_at, dag_id, dag_node_id, loop_id, variant_of, metadata
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    session.slug,
    session.title,
    session.prompt,
    session.mode,
    session.status,
    session.shipStage ?? null,
    null, null, null, null, null, null,
    null, null, null, 0, null, null, null,
    "[]", "[]",
    0, 0, 0, 0, 0, 0, 0, 0,
    "mock", null,
    session.createdAt,
    session.updatedAt,
    null, null, null, null, null, null, null,
    "{}",
  );
}

function insertShipState(db: Database.Database, slug: string, stage: string): void {
  db.prepare(
    `INSERT INTO ship_state(session_slug, stage, notes, updated_at) VALUES (?, ?, '[]', ?)`,
  ).run(slug, stage, new Date().toISOString());
}

interface MockCtxOptions {
  dags?: DAG[];
  readiness?: Map<string, MergeReadiness>;
}

function makeMockCtx(db: Database.Database, opts: MockCtxOptions = {}): EngineContext {
  const bus = new EventBus();
  const mutex = new KeyedMutex();
  const sessions = new Map<string, Session>();

  const dags = opts.dags ?? [];
  const readinessMap = opts.readiness ?? new Map<string, MergeReadiness>();

  return {
    bus,
    mutex,
    sessions: {
      get: (slug: string) => sessions.get(slug) ?? null,
      list: () => Array.from(sessions.values()),
      reply: async () => {},
    },
    dags: {
      list: () => dags,
      get: (id: string) => dags.find((d) => d.id === id) ?? null,
      splitNode: async () => { throw new Error("not impl"); },
      onSessionTerminal: async () => {},
    },
    readiness: {
      compute: async (slug: string) => {
        const r = readinessMap.get(slug);
        if (!r) throw new Error(`no readiness for ${slug}`);
        return r;
      },
      summary: () => ({ total: 0, ready: 0, blocked: 0, pending: 0, unknown: 0, bySession: [] }),
    },
    log: createLogger("error"),
    db,
    _sessions: sessions,
  } as unknown as EngineContext & { _sessions: Map<string, Session> };
}

function makeReadiness(slug: string, ciStatus: "ok" | "blocked" | "pending"): MergeReadiness {
  return {
    sessionSlug: slug,
    status: ciStatus === "ok" ? "ready" : ciStatus === "blocked" ? "blocked" : "pending",
    checks: [
      { id: "pr", label: "PR", status: "ok" },
      { id: "ci", label: "CI checks", status: ciStatus, detail: ciStatus === "blocked" ? "checks failed" : undefined },
      { id: "review", label: "Review", status: "ok" },
      { id: "quality", label: "Quality", status: "ok" },
      { id: "conflict", label: "Conflict", status: "ok" },
    ],
    computedAt: new Date().toISOString(),
  };
}

describe("ShipCoordinator.emitVerifySummary", () => {
  test("emits status event with PR urls when DAG has landed nodes", async () => {
    const db = makeTempDb();

    const slug = "ship-verify-1";
    const session = makeShipSession(slug);
    insertSession(db, session);
    insertShipState(db, slug, "verify");

    const childA = "child-a";
    const childB = "child-b";
    insertSession(db, { ...makeShipSession(childA), mode: "task", title: "child A" });
    insertSession(db, { ...makeShipSession(childB), mode: "task", title: "child B" });

    const dag: DAG = {
      id: "dag-test-1",
      title: "Ship the feature",
      goal: "ship X",
      rootSessionSlug: slug,
      nodes: [
        {
          id: "node-a",
          title: "node A",
          prompt: "do A",
          status: "landed",
          dependsOn: [],
          sessionSlug: childA,
          pr: { number: 101, url: "https://example.test/pr/101" },
          metadata: {},
        },
        {
          id: "node-b",
          title: "node B",
          prompt: "do B",
          status: "landed",
          dependsOn: ["node-a"],
          sessionSlug: childB,
          pr: { number: 202, url: "https://example.test/pr/202" },
          metadata: {},
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "active",
      metadata: {},
    };

    const readinessMap = new Map<string, MergeReadiness>([
      [childA, makeReadiness(childA, "ok")],
      [childB, makeReadiness(childB, "blocked")],
    ]);

    const ctx = makeMockCtx(db, { dags: [dag], readiness: readinessMap });
    const ctxWithSessions = ctx as EngineContext & { _sessions: Map<string, Session> };
    ctxWithSessions._sessions.set(slug, session);

    const statusEvents: StatusEvent[] = [];
    ctx.bus.on("transcript_event", (ev) => {
      if (ev.event.kind === "status") {
        statusEvents.push(ev.event);
      }
    });

    const coordinator = new ShipCoordinator(db, ctx, createLogger("error"));
    await coordinator.emitVerifySummary(slug);

    assert.equal(statusEvents.length, 1, "one status event emitted");
    const ev = statusEvents[0]!;
    assert.match(ev.text, /Verify summary/);
    assert.ok(ev.text.includes("https://example.test/pr/101"), "first PR url present");
    assert.ok(ev.text.includes("https://example.test/pr/202"), "second PR url present");
    assert.ok(ev.text.includes("node A"), "first node title present");
    assert.ok(ev.text.includes("node B"), "second node title present");
    assert.ok(ev.text.includes("ci ok"), "ci ok status present for node A");
    assert.ok(ev.text.includes("ci blocked"), "ci blocked status present for node B");

    const persisted = db
      .prepare(
        `SELECT body FROM transcript_events WHERE session_slug = ? AND kind = 'status' ORDER BY seq DESC LIMIT 1`,
      )
      .get(slug) as { body: string } | undefined;
    assert.ok(persisted, "status event was persisted");
    const persistedEvent = JSON.parse(persisted.body) as StatusEvent;
    assert.ok(persistedEvent.text.includes("https://example.test/pr/101"));
    assert.equal(persistedEvent.data?.["kind"], "verify_summary");
  });

  test("emits 'no DAG bound' message when ship session has no DAG", async () => {
    const db = makeTempDb();

    const slug = "ship-verify-2";
    const session = makeShipSession(slug);
    insertSession(db, session);
    insertShipState(db, slug, "verify");

    const ctx = makeMockCtx(db, { dags: [] });
    const ctxWithSessions = ctx as EngineContext & { _sessions: Map<string, Session> };
    ctxWithSessions._sessions.set(slug, session);

    const statusEvents: StatusEvent[] = [];
    ctx.bus.on("transcript_event", (ev) => {
      if (ev.event.kind === "status") {
        statusEvents.push(ev.event);
      }
    });

    const coordinator = new ShipCoordinator(db, ctx, createLogger("error"));

    await assert.doesNotReject(() => coordinator.emitVerifySummary(slug));

    assert.equal(statusEvents.length, 1, "still emits a status event when no DAG");
    assert.match(statusEvents[0]!.text, /no DAG bound/);
  });
});
