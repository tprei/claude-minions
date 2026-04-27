import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Session } from "@minions/shared";
import type { EngineContext } from "../context.js";
import { EventBus } from "../bus/eventBus.js";
import { KeyedMutex } from "../util/mutex.js";
import { createLogger } from "../logger.js";
import { openStore } from "../store/sqlite.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { ShipCoordinator } from "./coordinator.js";

function makeTempDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-test-"));
  return openStore({ path: path.join(dir, "engine.db"), log: createLogger("error") });
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

function makeShipSession(slug: string): Session {
  const now = new Date().toISOString();
  return {
    slug,
    title: "Test ship session",
    prompt: "implement feature X",
    mode: "ship",
    status: "running",
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

function makeMockCtx(db: Database.Database): EngineContext {
  const bus = new EventBus();
  const mutex = new KeyedMutex();
  const sessions = new Map<string, Session>();

  return {
    bus,
    mutex,
    sessions: {
      create: async () => { throw new Error("not implemented"); },
      get: (slug: string) => sessions.get(slug) ?? null,
      list: () => Array.from(sessions.values()),
      listWithTranscript: () => [],
      transcript: () => [],
      stop: async () => {},
      close: async () => {},
      reply: async (_slug: string, _text: string) => {},
      resumeAllActive: async () => {},
      diff: async (slug: string) => ({ sessionSlug: slug, patch: "", stats: [], truncated: false, byteSize: 0, generatedAt: new Date().toISOString() }),
      screenshots: async () => [],
      screenshotPath: () => "",
      checkpoints: () => [],
      restoreCheckpoint: async () => {},
    },
    runtime: {
      schema: () => ({ groups: [], fields: [] }),
      values: () => ({}),
      effective: () => ({}),
      update: async () => {},
    },
    dags: {} as EngineContext["dags"],
    ship: {} as EngineContext["ship"],
    landing: {} as EngineContext["landing"],
    loops: {} as EngineContext["loops"],
    variants: {} as EngineContext["variants"],
    ci: {} as EngineContext["ci"],
    quality: {} as EngineContext["quality"],
    readiness: {} as EngineContext["readiness"],
    intake: {} as EngineContext["intake"],
    memory: {} as EngineContext["memory"],
    audit: {} as EngineContext["audit"],
    resource: {} as EngineContext["resource"],
    push: {} as EngineContext["push"],
    digest: {} as EngineContext["digest"],
    github: {} as EngineContext["github"],
    stats: {} as EngineContext["stats"],
    env: {} as EngineContext["env"],
    log: createLogger("error"),
    db,
    workspaceDir: "/tmp",
    features: () => [],
    repos: () => [],
    shutdown: async () => {},
    _sessions: sessions,
  } as unknown as EngineContext & { _sessions: Map<string, Session> };
}

describe("ShipCoordinator", () => {
  test("advance through all stages emits status event per transition", async () => {
    const db = makeTempDb();
    const ctx = makeMockCtx(db) as unknown as EngineContext & { _sessions: Map<string, Session> };

    const sessionSlug = "ship-test-1";
    const session = makeShipSession(sessionSlug);
    insertSession(db, session);
    ctx._sessions.set(sessionSlug, session);

    const statusEvents: unknown[] = [];
    ctx.bus.on("transcript_event", (ev) => {
      if (ev.event.kind === "status") {
        statusEvents.push(ev.event);
      }
    });

    const repliedTexts: string[] = [];
    (ctx.sessions.reply as unknown as (slug: string, text: string) => Promise<void>) =
      async (_slug: string, text: string) => {
        repliedTexts.push(text);
      };

    const coordinator = new ShipCoordinator(db, ctx, createLogger("error"));

    await coordinator.advance(sessionSlug);

    assert.equal(statusEvents.length, 1, "one status event after first advance (think→plan)");
    const stageRow1 = db
      .prepare("SELECT stage FROM ship_state WHERE session_slug = ?")
      .get(sessionSlug) as { stage: string } | undefined;
    assert.equal(stageRow1?.stage, "plan");

    const sessionRow1 = db
      .prepare("SELECT ship_stage FROM sessions WHERE slug = ?")
      .get(sessionSlug) as { ship_stage: string } | undefined;
    assert.equal(sessionRow1?.ship_stage, "plan", "sessions table ship_stage updated");

    await coordinator.advance(sessionSlug);
    await coordinator.advance(sessionSlug);
    await coordinator.advance(sessionSlug);

    assert.equal(statusEvents.length, 4, "four status events total after four advances");

    const stageRow2 = db
      .prepare("SELECT stage FROM ship_state WHERE session_slug = ?")
      .get(sessionSlug) as { stage: string } | undefined;
    assert.equal(stageRow2?.stage, "done");

    assert.equal(repliedTexts.length, 4, "four reply calls (one per stage directive)");
    assert.ok(repliedTexts[0]?.includes("[Ship stage: plan]"), "first reply contains plan directive header");
  });

  test("advance to specific stage sets it directly", async () => {
    const db = makeTempDb();
    const ctx = makeMockCtx(db) as unknown as EngineContext & { _sessions: Map<string, Session> };

    const sessionSlug = "ship-test-2";
    const session = makeShipSession(sessionSlug);
    insertSession(db, session);
    ctx._sessions.set(sessionSlug, session);

    (ctx.sessions.reply as unknown as (slug: string, text: string) => Promise<void>) =
      async () => {};

    const coordinator = new ShipCoordinator(db, ctx, createLogger("error"));

    await coordinator.advance(sessionSlug, "verify");

    const stageRow = db
      .prepare("SELECT stage FROM ship_state WHERE session_slug = ?")
      .get(sessionSlug) as { stage: string } | undefined;
    assert.equal(stageRow?.stage, "verify");
  });
});
