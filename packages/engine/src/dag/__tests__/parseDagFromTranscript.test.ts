import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type {
  AssistantTextEvent,
  CreateSessionRequest,
  Session,
  TranscriptEvent,
} from "@minions/shared";
import type { EngineContext } from "../../context.js";
import { runMigrations } from "../../store/sqlite.js";
import { createLogger } from "../../logger.js";
import { EventBus } from "../../bus/eventBus.js";
import { KeyedMutex } from "../../util/mutex.js";
import { createDagSubsystem } from "../index.js";
import type { SubsystemDeps } from "../../wiring.js";

const SHIP_SLUG = "ship-sess-1";

function makeAssistantText(seq: number, text: string): AssistantTextEvent {
  return {
    id: `evt-${seq}`,
    sessionSlug: SHIP_SLUG,
    seq,
    turn: 0,
    timestamp: new Date().toISOString(),
    kind: "assistant_text",
    text,
  };
}

function makeShipSession(): Session {
  return {
    slug: SHIP_SLUG,
    title: "Ship session",
    prompt: "ship something",
    mode: "ship",
    status: "running",
    shipStage: "dag",
    repoId: "repo-x",
    baseBranch: "main",
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
  };
}

interface SpyState {
  setDagIdCalls: Array<{ slug: string; dagId: string }>;
  createCalls: CreateSessionRequest[];
  spawnedSessions: Session[];
}

function makeMockCtx(opts: {
  session: Session;
  transcriptRef: { events: TranscriptEvent[] };
  bus: EventBus;
  db: Database.Database;
  spy: SpyState;
}): EngineContext {
  const log = createLogger("error");
  let counter = 0;
  const ctx: Partial<EngineContext> = {
    bus: opts.bus,
    db: opts.db,
    log,
    mutex: new KeyedMutex(),
    workspaceDir: "/tmp",
    env: {} as EngineContext["env"],
    audit: {
      record: () => {},
      list: () => [],
    } as EngineContext["audit"],
    sessions: {
      create: async (req) => {
        opts.spy.createCalls.push(req);
        const slug = `mock-session-${++counter}`;
        const child: Session = {
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
        opts.spy.spawnedSessions.push(child);
        return child;
      },
      get: (slug) => (slug === opts.session.slug ? opts.session : null),
      list: () => [opts.session],
      listPaged: () => ({ items: [opts.session] }) as ReturnType<EngineContext["sessions"]["listPaged"]>,
      listWithTranscript: () => [],
      transcript: () => opts.transcriptRef.events,
      stop: async () => {},
      close: async () => {},
      delete: async () => {},
      reply: async () => {},
      setDagId: (slug, dagId) => {
        opts.spy.setDagIdCalls.push({ slug, dagId });
        opts.db
          .prepare(`UPDATE sessions SET dag_id = ? WHERE slug = ?`)
          .run(dagId, slug);
      },
      markWaitingInput: () => {},
      kickReplyQueue: async () => false,
      resumeAllActive: async () => {},
      diff: async (slug) => ({
        sessionSlug: slug,
        patch: "",
        stats: [],
        truncated: false,
        byteSize: 0,
        generatedAt: new Date().toISOString(),
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
    features: () => [],
    repos: () => [],
    shutdown: async () => {},
  };
  return ctx as EngineContext;
}

function makeDeps(ctx: EngineContext, db: Database.Database, bus: EventBus): SubsystemDeps {
  return {
    ctx,
    log: createLogger("error"),
    env: {} as SubsystemDeps["env"],
    db,
    bus,
    mutex: new KeyedMutex(),
    workspaceDir: "/tmp",
  };
}

function persistTranscript(db: Database.Database, events: TranscriptEvent[]): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO transcript_events(id, session_slug, seq, turn, kind, body, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const ev of events) {
    stmt.run(ev.id, ev.sessionSlug, ev.seq, ev.turn, ev.kind, JSON.stringify(ev), ev.timestamp);
  }
}

function insertSessionRow(db: Database.Database, session: Session): void {
  db.prepare(
    `INSERT INTO sessions(slug, title, prompt, mode, status, ship_stage, provider, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.slug,
    session.title,
    session.prompt,
    session.mode,
    session.status,
    session.shipStage ?? null,
    session.provider,
    session.createdAt,
    session.updatedAt,
  );
}

describe("parseDagFromTranscript handler", () => {
  let db: Database.Database;
  let bus: EventBus;
  let session: Session;
  let transcriptRef: { events: TranscriptEvent[] };
  let spy: SpyState;
  let shutdown: (() => Promise<void> | void) | undefined;
  let api: ReturnType<typeof createDagSubsystem>["api"];

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, createLogger("error"));

    bus = new EventBus();
    session = makeShipSession();
    insertSessionRow(db, session);
    transcriptRef = { events: [] };
    spy = { setDagIdCalls: [], createCalls: [], spawnedSessions: [] };

    const ctx = makeMockCtx({ session, transcriptRef, bus, db, spy });
    const sub = createDagSubsystem(makeDeps(ctx, db, bus));
    ctx.dags = sub.api;
    api = sub.api;
    shutdown = sub.onShutdown;
  });

  afterEach(async () => {
    if (shutdown) await shutdown();
    db.close();
  });

  test("parseable dag block sets session.dagId AND triggers scheduler.tick to spawn root nodes", async () => {
    const block = JSON.stringify({
      title: "Build login flow",
      goal: "Ship a working login form",
      nodes: [
        { title: "schema", prompt: "design users table", dependsOn: [] },
        { title: "api", prompt: "build /login", dependsOn: ["schema"] },
      ],
    });
    const ev = makeAssistantText(0, `\`\`\`dag\n${block}\n\`\`\``);
    transcriptRef.events.push(ev);
    persistTranscript(db, [ev]);

    bus.emit({ kind: "transcript_event", sessionSlug: SHIP_SLUG, event: ev });

    // scheduler.tick is fire-and-forget inside the subscriber; await microtasks.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const dags = api.list();
    assert.equal(dags.length, 1, "DAG was created");
    const dag = dags[0]!;

    assert.equal(spy.setDagIdCalls.length, 1, "setDagId was called once");
    assert.deepEqual(spy.setDagIdCalls[0], { slug: SHIP_SLUG, dagId: dag.id });

    const dagIdRow = db
      .prepare(`SELECT dag_id FROM sessions WHERE slug = ?`)
      .get(SHIP_SLUG) as { dag_id: string | null };
    assert.equal(dagIdRow.dag_id, dag.id, "session.dag_id persisted in DB");

    assert.ok(spy.createCalls.length >= 1, "scheduler.tick spawned at least one root node session");
    const schemaCall = spy.createCalls.find((c) => c.title === "schema");
    assert.ok(schemaCall, "root node 'schema' was spawned (no dependencies)");
    assert.equal(schemaCall.mode, "dag-task");
    assert.equal(schemaCall.repoId, "repo-x");
    assert.equal(schemaCall.baseBranch, "main");

    const refreshed = api.get(dag.id)!;
    const schemaNode = refreshed.nodes.find((n) => n.title === "schema")!;
    assert.equal(schemaNode.status, "running", "root node moved out of pending after tick");
    const apiNode = refreshed.nodes.find((n) => n.title === "api")!;
    assert.equal(apiNode.status, "pending", "dependent node still pending");
  });
});
