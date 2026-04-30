import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type {
  Session,
  TranscriptEvent,
  AssistantTextEvent,
  DAG,
  DAGNode,
  DAGNodeStatus,
  MergeReadiness,
} from "@minions/shared";
import type { EngineContext } from "../context.js";
import { EventBus } from "../bus/eventBus.js";
import { KeyedMutex } from "../util/mutex.js";
import { createLogger } from "../logger.js";
import { openStore } from "../store/sqlite.js";
import { newEventId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
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

function seedStage(db: Database.Database, slug: string, stage: string): void {
  db.prepare(`
    INSERT INTO ship_state(session_slug, stage, notes, updated_at)
    VALUES (?, ?, '[]', ?)
    ON CONFLICT(session_slug) DO UPDATE SET stage = excluded.stage, updated_at = excluded.updated_at
  `).run(slug, stage, nowIso());
  db.prepare(`UPDATE sessions SET ship_stage = ?, updated_at = ? WHERE slug = ?`).run(
    stage,
    nowIso(),
    slug,
  );
}

function makeAssistantText(slug: string, seq: number, text: string): AssistantTextEvent {
  return {
    id: newEventId(),
    sessionSlug: slug,
    seq,
    turn: 0,
    timestamp: nowIso(),
    kind: "assistant_text",
    text,
  };
}

function makeNode(id: string, status: DAGNodeStatus): DAGNode {
  return {
    id,
    title: id,
    prompt: id,
    status,
    dependsOn: [],
    metadata: {},
  };
}

function makeDag(rootSessionSlug: string, nodes: DAGNode[]): DAG {
  const now = nowIso();
  return {
    id: `dag-${rootSessionSlug}`,
    title: "test dag",
    goal: "test",
    rootSessionSlug,
    nodes,
    createdAt: now,
    updatedAt: now,
    status: "active",
    metadata: {},
  };
}

interface MockCtxOpts {
  transcript?: TranscriptEvent[];
  dags?: DAG[];
  readinessCompute?: (slug: string) => Promise<MergeReadiness | null>;
}

interface MockCtxHandle {
  ctx: EngineContext;
  sessions: Map<string, Session>;
  repliedTexts: string[];
  statusEvents: unknown[];
  waitingInputCalls: { slug: string; reason?: string }[];
}

function makeMockCtx(db: Database.Database, opts: MockCtxOpts = {}): MockCtxHandle {
  const bus = new EventBus();
  const mutex = new KeyedMutex();
  const sessions = new Map<string, Session>();
  const repliedTexts: string[] = [];
  const statusEvents: unknown[] = [];
  const waitingInputCalls: { slug: string; reason?: string }[] = [];
  const transcript = opts.transcript ?? [];

  bus.on("transcript_event", (ev) => {
    if (ev.event.kind === "status") statusEvents.push(ev.event);
  });

  const ctx = {
    bus,
    mutex,
    sessions: {
      create: async () => { throw new Error("not implemented"); },
      get: (slug: string) => sessions.get(slug) ?? null,
      list: () => Array.from(sessions.values()),
      listPaged: () => ({ items: [], total: 0 }),
      listWithTranscript: () => [],
      transcript: () => transcript,
      stop: async () => {},
      close: async () => {},
      reply: async (_slug: string, text: string) => {
        repliedTexts.push(text);
      },
      markWaitingInput: (slug: string, reason?: string) => {
        waitingInputCalls.push({ slug, reason });
      },
      markCompleted: () => {},
      resumeAllActive: async () => {},
      diff: async (slug: string) => ({
        sessionSlug: slug,
        patch: "",
        stats: [],
        truncated: false,
        byteSize: 0,
        generatedAt: nowIso(),
      }),
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
    dags: {
      list: () => opts.dags ?? [],
      get: () => null,
      splitNode: async () => { throw new Error("not implemented"); },
      onSessionTerminal: async () => {},
    },
    ship: {} as EngineContext["ship"],
    landing: {} as EngineContext["landing"],
    loops: {} as EngineContext["loops"],
    variants: {} as EngineContext["variants"],
    ci: {} as EngineContext["ci"],
    quality: {} as EngineContext["quality"],
    readiness: {
      compute: opts.readinessCompute ?? (async () => null),
      summary: () => ({
        total: 0,
        ready: 0,
        blocked: 0,
        pending: 0,
        unknown: 0,
        bySession: [],
      }),
    },
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
  } as unknown as EngineContext;

  return { ctx, sessions, repliedTexts, statusEvents, waitingInputCalls };
}

function getStageFromDb(db: Database.Database, slug: string): string | undefined {
  const row = db
    .prepare("SELECT stage FROM ship_state WHERE session_slug = ?")
    .get(slug) as { stage: string } | undefined;
  return row?.stage;
}

const PARSEABLE_DAG_BLOCK = `Here is the plan:

\`\`\`dag
${JSON.stringify({
  title: "Plan A",
  goal: "ship feature X",
  nodes: [
    { title: "node 1", prompt: "do thing 1" },
    { title: "node 2", prompt: "do thing 2", dependsOn: [] },
  ],
})}
\`\`\`
`;

describe("ShipCoordinator.onTurnCompleted", () => {
  test("think advances to plan when transcript has long assistant_text", async () => {
    const db = makeTempDb();
    const slug = "ship-think-1";
    const session = makeShipSession(slug);
    insertSession(db, session);
    seedStage(db, slug, "think");

    const longText = "x".repeat(250);
    const handle = makeMockCtx(db, {
      transcript: [makeAssistantText(slug, 0, longText)],
    });
    handle.sessions.set(slug, session);

    const coordinator = new ShipCoordinator(db, handle.ctx, createLogger("error"));
    await coordinator.onTurnCompleted(slug);

    assert.equal(getStageFromDb(db, slug), "plan");
    assert.equal(handle.statusEvents.length, 1, "one status event after think→plan");
    assert.equal(handle.repliedTexts.length, 1, "directive replied once");
    assert.ok(handle.repliedTexts[0]?.includes("[Ship stage: plan]"));
  });

  test("think does not advance when only short assistant_text", async () => {
    const db = makeTempDb();
    const slug = "ship-think-2";
    const session = makeShipSession(slug);
    insertSession(db, session);
    seedStage(db, slug, "think");

    const handle = makeMockCtx(db, {
      transcript: [makeAssistantText(slug, 0, "too short")],
    });
    handle.sessions.set(slug, session);

    const coordinator = new ShipCoordinator(db, handle.ctx, createLogger("error"));
    await coordinator.onTurnCompleted(slug);

    assert.equal(getStageFromDb(db, slug), "think");
    assert.equal(handle.statusEvents.length, 0);
    assert.equal(handle.repliedTexts.length, 0);
  });

  test("plan advances to dag when transcript has parseable dag block", async () => {
    const db = makeTempDb();
    const slug = "ship-plan-1";
    const session = makeShipSession(slug);
    insertSession(db, session);
    seedStage(db, slug, "plan");

    const handle = makeMockCtx(db, {
      transcript: [makeAssistantText(slug, 0, PARSEABLE_DAG_BLOCK)],
    });
    handle.sessions.set(slug, session);

    const coordinator = new ShipCoordinator(db, handle.ctx, createLogger("error"));
    await coordinator.onTurnCompleted(slug);

    assert.equal(getStageFromDb(db, slug), "dag");
    assert.equal(
      handle.repliedTexts.length,
      0,
      "dag advance must not enqueue a parent directive (would re-spawn parent)",
    );
    assert.equal(handle.waitingInputCalls.length, 1);
    assert.equal(handle.waitingInputCalls[0]!.slug, slug);
  });

  test("plan does not advance without parseable dag block", async () => {
    const db = makeTempDb();
    const slug = "ship-plan-2";
    const session = makeShipSession(slug);
    insertSession(db, session);
    seedStage(db, slug, "plan");

    const handle = makeMockCtx(db, {
      transcript: [
        makeAssistantText(slug, 0, "I plan to do X then Y, no fenced block here"),
      ],
    });
    handle.sessions.set(slug, session);

    const coordinator = new ShipCoordinator(db, handle.ctx, createLogger("error"));
    await coordinator.onTurnCompleted(slug);

    assert.equal(getStageFromDb(db, slug), "plan");
    assert.equal(handle.repliedTexts.length, 0);
  });

  test("dag does not advance when no DAG exists for session", async () => {
    const db = makeTempDb();
    const slug = "ship-dag-1";
    const session = makeShipSession(slug);
    insertSession(db, session);
    seedStage(db, slug, "dag");

    const handle = makeMockCtx(db, { dags: [] });
    handle.sessions.set(slug, session);

    const coordinator = new ShipCoordinator(db, handle.ctx, createLogger("error"));
    await coordinator.onTurnCompleted(slug);

    assert.equal(getStageFromDb(db, slug), "dag");
    assert.equal(handle.repliedTexts.length, 0);
  });

  test("dag advances to verify when all DAG nodes are landed", async () => {
    const db = makeTempDb();
    const slug = "ship-dag-2";
    const session = makeShipSession(slug);
    insertSession(db, session);
    seedStage(db, slug, "dag");

    const dag = makeDag(slug, [
      makeNode("n1", "landed"),
      makeNode("n2", "landed"),
    ]);
    const handle = makeMockCtx(db, { dags: [dag] });
    handle.sessions.set(slug, session);

    const coordinator = new ShipCoordinator(db, handle.ctx, createLogger("error"));
    await coordinator.onTurnCompleted(slug);

    assert.equal(getStageFromDb(db, slug), "verify");
    assert.ok(handle.repliedTexts[0]?.includes("[Ship stage: verify]"));
  });

  test("dag does not advance while nodes are still running", async () => {
    const db = makeTempDb();
    const slug = "ship-dag-3";
    const session = makeShipSession(slug);
    insertSession(db, session);
    seedStage(db, slug, "dag");

    const dag = makeDag(slug, [
      makeNode("n1", "landed"),
      makeNode("n2", "running"),
    ]);
    const handle = makeMockCtx(db, { dags: [dag] });
    handle.sessions.set(slug, session);

    const coordinator = new ShipCoordinator(db, handle.ctx, createLogger("error"));
    await coordinator.onTurnCompleted(slug);

    assert.equal(getStageFromDb(db, slug), "dag");
    assert.equal(handle.repliedTexts.length, 0);
  });

  test("verify does not advance when readiness compute returns null", async () => {
    const db = makeTempDb();
    const slug = "ship-verify-1";
    const session = makeShipSession(slug);
    insertSession(db, session);
    seedStage(db, slug, "verify");

    const handle = makeMockCtx(db, {
      readinessCompute: async () => null,
    });
    handle.sessions.set(slug, session);

    const coordinator = new ShipCoordinator(db, handle.ctx, createLogger("error"));
    await coordinator.onTurnCompleted(slug);

    assert.equal(getStageFromDb(db, slug), "verify");
    assert.equal(handle.repliedTexts.length, 0);
  });

  test("verify does not crash when readiness compute throws", async () => {
    const db = makeTempDb();
    const slug = "ship-verify-2";
    const session = makeShipSession(slug);
    insertSession(db, session);
    seedStage(db, slug, "verify");

    const handle = makeMockCtx(db, {
      readinessCompute: async () => {
        throw new Error("readiness unavailable");
      },
    });
    handle.sessions.set(slug, session);

    const coordinator = new ShipCoordinator(db, handle.ctx, createLogger("error"));
    await coordinator.onTurnCompleted(slug);

    assert.equal(getStageFromDb(db, slug), "verify");
    assert.equal(handle.repliedTexts.length, 0);
  });

  test("concurrent onTurnCompleted calls serialize via mutex; only one advance happens", async () => {
    const db = makeTempDb();
    const slug = "ship-concurrent";
    const session = makeShipSession(slug);
    insertSession(db, session);
    seedStage(db, slug, "think");

    const longText = "y".repeat(250);
    const handle = makeMockCtx(db, {
      transcript: [makeAssistantText(slug, 0, longText)],
    });
    handle.sessions.set(slug, session);

    const coordinator = new ShipCoordinator(db, handle.ctx, createLogger("error"));

    await Promise.all([
      coordinator.onTurnCompleted(slug),
      coordinator.onTurnCompleted(slug),
    ]);

    assert.equal(getStageFromDb(db, slug), "plan", "stage advances exactly once");
    assert.equal(handle.statusEvents.length, 1, "exactly one transition status event");
    assert.equal(handle.repliedTexts.length, 1, "exactly one stage directive replied");
  });
});
