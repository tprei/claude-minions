import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type {
  AssistantTextEvent,
  DAG,
  MergeReadiness,
  Session,
  StatusEvent,
  TranscriptEvent,
} from "@minions/shared";
import type { EngineContext } from "../context.js";
import { EventBus } from "../bus/eventBus.js";
import { KeyedMutex } from "../util/mutex.js";
import { createLogger } from "../logger.js";
import { openStore } from "../store/sqlite.js";
import { nowIso } from "../util/time.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { ShipCoordinator } from "./coordinator.js";
import { createDagSubsystem } from "../dag/index.js";
import { AutomationJobRepo } from "../store/repos/automationJobRepo.js";

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

interface MockCtxOpts {
  dags?: DAG[];
  readinessCompute?: (slug: string) => Promise<MergeReadiness | null>;
  transcript?: TranscriptEvent[];
}

function makeMockCtx(db: Database.Database, opts: MockCtxOpts = {}): EngineContext {
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
      transcript: () => opts.transcript ?? [],
      stop: async () => {},
      close: async () => {},
      reply: async (_slug: string, _text: string) => {},
      markWaitingInput: (slug: string, _reason?: string) => {
        const s = sessions.get(slug);
        if (s) sessions.set(slug, { ...s, status: "waiting_input" });
        db.prepare(`UPDATE sessions SET status = 'waiting_input' WHERE slug = ?`).run(slug);
      },
      kickReplyQueue: async () => false,
      setDagId: () => {},
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
    dags: ({
      list: () => opts.dags ?? [],
      get: (id: string) => opts.dags?.find((d) => d.id === id) ?? null,
      splitNode: async () => { throw new Error("not implemented"); },
      onSessionTerminal: async () => {},
      retry: async () => {},
      cancel: async () => {},
      forceLand: async () => {},
      tryCreateFromTranscript: async () => ({ created: false }),
    } as unknown as EngineContext["dags"]),
    ship: {} as EngineContext["ship"],
    landing: {} as EngineContext["landing"],
    loops: {} as EngineContext["loops"],
    variants: {} as EngineContext["variants"],
    ci: {} as EngineContext["ci"],
    quality: {} as EngineContext["quality"],
    readiness: opts.readinessCompute !== undefined ? ({
      compute: opts.readinessCompute,
      summary: () => ({ total: 0, ready: 0, blocked: 0, pending: 0, unknown: 0, bySession: [] }),
    } as unknown as EngineContext["readiness"]) : ({} as EngineContext["readiness"]),
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

    assert.equal(
      statusEvents.length,
      5,
      "four stage-transition events plus one verify_summary emitted on dag→verify",
    );

    const stageRow2 = db
      .prepare("SELECT stage FROM ship_state WHERE session_slug = ?")
      .get(sessionSlug) as { stage: string } | undefined;
    assert.equal(stageRow2?.stage, "done");

    assert.equal(
      repliedTexts.length,
      3,
      "three reply calls (plan, verify, done — dag stage skips parent directive)",
    );
    assert.ok(repliedTexts[0]?.includes("[Ship stage: plan]"), "first reply contains plan directive header");
    assert.ok(
      repliedTexts.every((t) => !t.includes("[Ship stage: dag]")),
      "no reply enqueued for dag stage",
    );
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

  test("reconcileOnBoot advances dag→verify when all DAG nodes already landed", async () => {
    const db = makeTempDb();

    const sessionSlug = "ship-boot-1";
    const session = { ...makeShipSession(sessionSlug), shipStage: "dag" as const };
    insertSession(db, session);

    db.prepare(
      `INSERT INTO ship_state(session_slug, stage, notes, updated_at) VALUES (?, ?, '[]', ?)`,
    ).run(sessionSlug, "dag", nowIso());

    const dag: DAG = {
      id: `dag-${sessionSlug}`,
      title: "boot dag",
      goal: "ship X",
      rootSessionSlug: sessionSlug,
      nodes: [
        { id: "n1", title: "n1", prompt: "do n1", status: "landed", dependsOn: [], metadata: {} },
        { id: "n2", title: "n2", prompt: "do n2", status: "landed", dependsOn: [], metadata: {} },
      ],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: "active",
      metadata: {},
    };

    const ctx = makeMockCtx(db, { dags: [dag] }) as unknown as EngineContext & {
      _sessions: Map<string, Session>;
    };
    ctx._sessions.set(sessionSlug, session);

    const statusEvents: StatusEvent[] = [];
    ctx.bus.on("transcript_event", (ev) => {
      if (ev.event.kind === "status") statusEvents.push(ev.event);
    });

    const coordinator = new ShipCoordinator(db, ctx, createLogger("error"));
    await coordinator.reconcileOnBoot();

    const stageRow = db
      .prepare("SELECT stage FROM ship_state WHERE session_slug = ?")
      .get(sessionSlug) as { stage: string } | undefined;
    assert.equal(stageRow?.stage, "verify", "boot reconcile advances dag→verify");

    const sessionRow = db
      .prepare("SELECT ship_stage FROM sessions WHERE slug = ?")
      .get(sessionSlug) as { ship_stage: string } | undefined;
    assert.equal(sessionRow?.ship_stage, "verify", "sessions table ship_stage updated");

    const verifySummary = statusEvents.find((e) => e.data?.["kind"] === "verify_summary");
    assert.ok(verifySummary, "verify_summary status event emitted");
    assert.match(verifySummary.text, /Verify summary/);
  });

  test("think advances when summed short assistant_text events exceed threshold", async () => {
    const db = makeTempDb();

    const sessionSlug = "ship-think-sum";
    const session = makeShipSession(sessionSlug);
    insertSession(db, session);

    db.prepare(
      `INSERT INTO ship_state(session_slug, stage, notes, updated_at) VALUES (?, ?, '[]', ?)`,
    ).run(sessionSlug, "think", nowIso());
    db.prepare(`UPDATE sessions SET ship_stage = ? WHERE slug = ?`).run(
      "think",
      sessionSlug,
    );

    const ts = nowIso();
    const chunk = "a".repeat(34);
    const transcript: TranscriptEvent[] = [
      { id: "ev-0", sessionSlug, seq: 0, turn: 0, timestamp: ts, kind: "assistant_text", text: chunk },
      { id: "ev-1", sessionSlug, seq: 1, turn: 0, timestamp: ts, kind: "assistant_text", text: chunk },
      { id: "ev-2", sessionSlug, seq: 2, turn: 0, timestamp: ts, kind: "assistant_text", text: chunk },
    ];

    const ctx = makeMockCtx(db, { transcript }) as unknown as EngineContext & {
      _sessions: Map<string, Session>;
    };
    ctx._sessions.set(sessionSlug, session);

    (ctx.sessions.reply as unknown as (slug: string, text: string) => Promise<void>) =
      async () => {};

    const coordinator = new ShipCoordinator(db, ctx, createLogger("error"));
    await coordinator.onTurnCompleted(sessionSlug);

    const stageRow = db
      .prepare("SELECT stage FROM ship_state WHERE session_slug = ?")
      .get(sessionSlug) as { stage: string } | undefined;
    assert.equal(
      stageRow?.stage,
      "plan",
      "three short assistant_text events totaling ~102 chars trigger think→plan",
    );
  });

  test("advance to dag marks session waiting_input", async () => {
    const db = makeTempDb();
    const ctx = makeMockCtx(db) as unknown as EngineContext & { _sessions: Map<string, Session> };

    const sessionSlug = "ship-dag-wait";
    const session = makeShipSession(sessionSlug);
    insertSession(db, session);
    ctx._sessions.set(sessionSlug, session);

    (ctx.sessions.reply as unknown as (slug: string, text: string) => Promise<void>) =
      async () => {};

    const coordinator = new ShipCoordinator(db, ctx, createLogger("error"));

    await coordinator.advance(sessionSlug, "dag");

    const stageRow = db
      .prepare("SELECT stage FROM ship_state WHERE session_slug = ?")
      .get(sessionSlug) as { stage: string } | undefined;
    assert.equal(stageRow?.stage, "dag");

    const sessionRow = db
      .prepare("SELECT status FROM sessions WHERE slug = ?")
      .get(sessionSlug) as { status: string } | undefined;
    assert.equal(sessionRow?.status, "waiting_input", "parent session marked waiting_input on dag stage");

    const inMemory = ctx.sessions.get(sessionSlug);
    assert.equal(inMemory?.status, "waiting_input", "in-memory session reflects waiting_input");
  });

  test("advance to dag does not enqueue a parent directive", async () => {
    const db = makeTempDb();
    const ctx = makeMockCtx(db) as unknown as EngineContext & { _sessions: Map<string, Session> };

    const sessionSlug = "ship-dag-no-reply";
    const session = makeShipSession(sessionSlug);
    insertSession(db, session);
    ctx._sessions.set(sessionSlug, session);

    const repliedTexts: string[] = [];
    (ctx.sessions.reply as unknown as (slug: string, text: string) => Promise<void>) =
      async (_slug: string, text: string) => {
        repliedTexts.push(text);
      };

    const coordinator = new ShipCoordinator(db, ctx, createLogger("error"));

    await coordinator.advance(sessionSlug, "dag");

    assert.equal(
      repliedTexts.length,
      0,
      "no reply directive enqueued for parent ship session on dag advance",
    );

    const sessionRow = db
      .prepare("SELECT status FROM sessions WHERE slug = ?")
      .get(sessionSlug) as { status: string } | undefined;
    assert.equal(sessionRow?.status, "waiting_input");
  });

  test("advance to plan does not mark session waiting_input", async () => {
    const db = makeTempDb();
    const ctx = makeMockCtx(db) as unknown as EngineContext & { _sessions: Map<string, Session> };

    const sessionSlug = "ship-plan-no-wait";
    const session = makeShipSession(sessionSlug);
    insertSession(db, session);
    ctx._sessions.set(sessionSlug, session);

    (ctx.sessions.reply as unknown as (slug: string, text: string) => Promise<void>) =
      async () => {};

    const coordinator = new ShipCoordinator(db, ctx, createLogger("error"));

    await coordinator.advance(sessionSlug, "plan");

    const sessionRow = db
      .prepare("SELECT status FROM sessions WHERE slug = ?")
      .get(sessionSlug) as { status: string } | undefined;
    assert.notEqual(sessionRow?.status, "waiting_input");
  });

  test("advance to dag with parseable transcript block creates a DAG and sets parent.dagId", async () => {
    const db = makeTempDb();

    const sessionSlug = "ship-dag-create";
    const session = makeShipSession(sessionSlug);
    insertSession(db, session);

    const dagBlock = JSON.stringify({
      title: "ship dag",
      goal: "build it",
      nodes: [{ title: "root", prompt: "do root", dependsOn: [] }],
    });
    const transcriptEv: AssistantTextEvent = {
      id: "tev-0",
      sessionSlug,
      seq: 0,
      turn: 0,
      timestamp: nowIso(),
      kind: "assistant_text",
      text: `\`\`\`dag\n${dagBlock}\n\`\`\``,
    };
    db.prepare(
      `INSERT INTO transcript_events(id, session_slug, seq, turn, kind, body, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      transcriptEv.id,
      transcriptEv.sessionSlug,
      transcriptEv.seq,
      transcriptEv.turn,
      transcriptEv.kind,
      JSON.stringify(transcriptEv),
      transcriptEv.timestamp,
    );

    const ctx = makeMockCtx(db, { transcript: [transcriptEv] }) as unknown as EngineContext & {
      _sessions: Map<string, Session>;
    };
    ctx._sessions.set(sessionSlug, session);

    const setDagIdCalls: { slug: string; dagId: string }[] = [];
    (ctx.sessions.setDagId as unknown as (slug: string, dagId: string) => void) =
      (slug: string, dagId: string) => {
        setDagIdCalls.push({ slug, dagId });
        db.prepare(`UPDATE sessions SET dag_id = ? WHERE slug = ?`).run(dagId, slug);
      };

    let counter = 0;
    (ctx.sessions.create as unknown as (req: import("@minions/shared").CreateSessionRequest) => Promise<Session>) =
      async (req) => {
        const slug = `mock-child-${++counter}`;
        return {
          slug,
          title: req.title ?? slug,
          prompt: req.prompt,
          mode: req.mode ?? "task",
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
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          childSlugs: [],
          metadata: (req.metadata ?? {}) as Record<string, unknown>,
        };
      };

    const dagSub = createDagSubsystem({
      ctx,
      log: createLogger("error"),
      env: {} as Parameters<typeof createDagSubsystem>[0]["env"],
      db,
      bus: ctx.bus,
      mutex: ctx.mutex,
      workspaceDir: "/tmp",
      automationRepo: new AutomationJobRepo(db),
    });
    ctx.dags = dagSub.api;

    const coordinator = new ShipCoordinator(db, ctx, createLogger("error"));
    await coordinator.advance(sessionSlug, "dag");

    const dags = ctx.dags.list();
    assert.equal(dags.length, 1, "DAG was created during ship advance");
    const dag = dags[0]!;
    assert.equal(dag.rootSessionSlug, sessionSlug);
    assert.equal(dag.nodes.length, 1);

    const parentCalls = setDagIdCalls.filter((c) => c.slug === sessionSlug);
    assert.equal(parentCalls.length, 1, "parent session.setDagId called exactly once");
    assert.equal(parentCalls[0]!.dagId, dag.id);

    const dagIdRow = db
      .prepare(`SELECT dag_id FROM sessions WHERE slug = ?`)
      .get(sessionSlug) as { dag_id: string | null };
    assert.equal(dagIdRow.dag_id, dag.id, "session.dag_id persisted");

    const sessionRow = db
      .prepare(`SELECT status FROM sessions WHERE slug = ?`)
      .get(sessionSlug) as { status: string };
    assert.equal(sessionRow.status, "waiting_input", "parent stays waiting after dag advance");

    if (dagSub.onShutdown) await dagSub.onShutdown();
  });

  test("reconcileOnBoot skips terminated ship sessions", async () => {
    const db = makeTempDb();

    const sessionSlug = "ship-boot-terminated";
    const session = {
      ...makeShipSession(sessionSlug),
      status: "completed" as const,
      shipStage: "dag" as const,
    };
    insertSession(db, session);

    db.prepare(
      `INSERT INTO ship_state(session_slug, stage, notes, updated_at) VALUES (?, ?, '[]', ?)`,
    ).run(sessionSlug, "dag", nowIso());

    const dag: DAG = {
      id: `dag-${sessionSlug}`,
      title: "terminated dag",
      goal: "ship X",
      rootSessionSlug: sessionSlug,
      nodes: [
        { id: "n1", title: "n1", prompt: "do n1", status: "landed", dependsOn: [], metadata: {} },
      ],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: "active",
      metadata: {},
    };

    const ctx = makeMockCtx(db, { dags: [dag] }) as unknown as EngineContext & {
      _sessions: Map<string, Session>;
    };
    ctx._sessions.set(sessionSlug, session);

    const coordinator = new ShipCoordinator(db, ctx, createLogger("error"));
    await coordinator.reconcileOnBoot();

    const stageRow = db
      .prepare("SELECT stage FROM ship_state WHERE session_slug = ?")
      .get(sessionSlug) as { stage: string } | undefined;
    assert.equal(stageRow?.stage, "dag", "terminated session is not advanced");
  });
});
