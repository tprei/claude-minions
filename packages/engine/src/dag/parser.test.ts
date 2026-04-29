import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type {
  AssistantTextEvent,
  Session,
  StatusEvent,
  TranscriptEvent,
} from "@minions/shared";
import type { EngineContext } from "../context.js";
import { runMigrations } from "../store/sqlite.js";
import { createLogger } from "../logger.js";
import { EventBus } from "../bus/eventBus.js";
import { KeyedMutex } from "../util/mutex.js";
import { createDagSubsystem } from "./index.js";
import { parseDagFromTranscript } from "./parser.js";
import type { SubsystemDeps } from "../wiring.js";

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

function makeSession(overrides: Partial<Session> = {}): Session {
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
    ...overrides,
  };
}

function makeMockCtx(opts: {
  session: Session;
  transcriptRef: { events: TranscriptEvent[] };
  bus: EventBus;
  db: Database.Database;
}): EngineContext {
  const log = createLogger("error");
  const ctx: Partial<EngineContext> = {
    bus: opts.bus,
    db: opts.db,
    log,
    mutex: new KeyedMutex(),
    workspaceDir: "/tmp",
    env: {} as EngineContext["env"],
    sessions: {
      create: async () => opts.session,
      get: (slug) => (slug === opts.session.slug ? opts.session : null),
      list: () => [opts.session],
      listPaged: () => ({ items: [opts.session] }) as ReturnType<EngineContext["sessions"]["listPaged"]>,
      listWithTranscript: () => [],
      transcript: () => opts.transcriptRef.events,
      stop: async () => {},
      close: async () => {},
      delete: async () => {},
      reply: async () => {},
      setDagId: () => {},
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
      updateBucket: () => {},
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

function statusWarnings(db: Database.Database, slug: string): StatusEvent[] {
  const rows = db
    .prepare(
      `SELECT body FROM transcript_events WHERE session_slug = ? AND kind = 'status' ORDER BY seq ASC`,
    )
    .all(slug) as { body: string }[];
  return rows
    .map((r) => JSON.parse(r.body) as StatusEvent)
    .filter((e) => e.level === "warn");
}

function statusInfos(db: Database.Database, slug: string): StatusEvent[] {
  const rows = db
    .prepare(
      `SELECT body FROM transcript_events WHERE session_slug = ? AND kind = 'status' ORDER BY seq ASC`,
    )
    .all(slug) as { body: string }[];
  return rows
    .map((r) => JSON.parse(r.body) as StatusEvent)
    .filter((e) => e.level === "info");
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

describe("dag transcript subscriber", () => {
  let db: Database.Database;
  let bus: EventBus;
  let session: Session;
  let transcriptRef: { events: TranscriptEvent[] };
  let shutdown: (() => Promise<void> | void) | undefined;
  let api: ReturnType<typeof createDagSubsystem>["api"];

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, createLogger("error"));

    bus = new EventBus();
    session = makeSession();
    insertSessionRow(db, session);
    transcriptRef = { events: [] };

    const ctx = makeMockCtx({ session, transcriptRef, bus, db });
    const sub = createDagSubsystem(makeDeps(ctx, db, bus));
    ctx.dags = sub.api;
    api = sub.api;
    shutdown = sub.onShutdown;
  });

  afterEach(async () => {
    if (shutdown) await shutdown();
    db.close();
  });

  test("creates a DAG when transcript contains a valid fenced ```dag block", () => {
    const block = JSON.stringify({
      title: "Build login flow",
      goal: "Ship a working login form",
      nodes: [
        { title: "schema", prompt: "design users table", dependsOn: [] },
        { title: "api", prompt: "build /login", dependsOn: ["schema"] },
        { title: "ui", prompt: "wire form", dependsOn: ["api"] },
      ],
    });
    const text = `Here's the plan:\n\n\`\`\`dag\n${block}\n\`\`\`\n`;
    const ev = makeAssistantText(0, text);
    transcriptRef.events.push(ev);
    persistTranscript(db, [ev]);

    bus.emit({ kind: "transcript_event", sessionSlug: SHIP_SLUG, event: ev });

    const dags = api.list();
    assert.equal(dags.length, 1, "one DAG created");
    const dag = dags[0]!;
    assert.equal(dag.title, "Build login flow");
    assert.equal(dag.goal, "Ship a working login form");
    assert.equal(dag.rootSessionSlug, SHIP_SLUG);
    assert.equal(dag.nodes.length, 3);

    const titles = dag.nodes.map((n) => n.title);
    assert.deepEqual(titles, ["schema", "api", "ui"]);

    const apiNode = dag.nodes.find((n) => n.title === "api");
    const uiNode = dag.nodes.find((n) => n.title === "ui");
    const schemaNode = dag.nodes.find((n) => n.title === "schema");
    assert.ok(apiNode && uiNode && schemaNode);
    assert.deepEqual(apiNode.dependsOn, [schemaNode.id]);
    assert.deepEqual(uiNode.dependsOn, [apiNode.id]);
    assert.deepEqual(schemaNode.dependsOn, []);

    const infos = statusInfos(db, SHIP_SLUG);
    assert.equal(infos.length, 1, "one info status emitted");
    assert.match(infos[0]!.text, /Created DAG .* with 3 nodes/);
  });

  test("malformed fenced block emits a single warning and creates no DAG", () => {
    const text = "Plan:\n\n```dag\n{ this is not json }\n```\n";
    const ev = makeAssistantText(0, text);
    transcriptRef.events.push(ev);
    persistTranscript(db, [ev]);

    bus.emit({ kind: "transcript_event", sessionSlug: SHIP_SLUG, event: ev });
    bus.emit({ kind: "transcript_event", sessionSlug: SHIP_SLUG, event: ev });

    const dags = api.list();
    assert.equal(dags.length, 0, "no DAG created for malformed block");

    const warns = statusWarnings(db, SHIP_SLUG);
    assert.equal(warns.length, 1, "exactly one warning emitted");
    assert.match(warns[0]!.text, /failed to parse/);
  });

  test("a valid block emitted twice only creates the DAG once", () => {
    const block = JSON.stringify({
      title: "T",
      goal: "G",
      nodes: [{ title: "n1", prompt: "p1", dependsOn: [] }],
    });
    const text = `\`\`\`dag\n${block}\n\`\`\``;
    const ev = makeAssistantText(0, text);
    transcriptRef.events.push(ev);
    persistTranscript(db, [ev]);

    bus.emit({ kind: "transcript_event", sessionSlug: SHIP_SLUG, event: ev });
    bus.emit({ kind: "transcript_event", sessionSlug: SHIP_SLUG, event: ev });

    const dags = api.list();
    assert.equal(dags.length, 1, "DAG created exactly once");
    assert.equal(dags[0]!.nodes.length, 1);
  });

  test("non-ship sessions are ignored even with a valid fenced block", () => {
    session.mode = "task";
    const block = JSON.stringify({
      title: "T",
      goal: "G",
      nodes: [{ title: "n1", prompt: "p1", dependsOn: [] }],
    });
    const ev = makeAssistantText(0, `\`\`\`dag\n${block}\n\`\`\``);
    transcriptRef.events.push(ev);
    persistTranscript(db, [ev]);

    bus.emit({ kind: "transcript_event", sessionSlug: SHIP_SLUG, event: ev });

    assert.equal(api.list().length, 0);
    assert.equal(statusInfos(db, SHIP_SLUG).length, 0);
  });

  test("dag block with nested ```ts fence in node prompt parses correctly", () => {
    const nestedPrompt =
      "Implement the schema. Example:\n```ts\nexport interface User {\n  id: string;\n  email: string;\n}\n```\nThen migrate.";
    const block = JSON.stringify({
      title: "Build login flow",
      goal: "Ship a working login form",
      nodes: [
        { title: "schema", prompt: nestedPrompt, dependsOn: [] },
        { title: "api", prompt: "build /login", dependsOn: ["schema"] },
      ],
    });
    const text = `Plan:\n\n\`\`\`dag\n${block}\n\`\`\`\n\nlet me know.`;
    const ev = makeAssistantText(0, text);
    transcriptRef.events.push(ev);
    persistTranscript(db, [ev]);

    bus.emit({ kind: "transcript_event", sessionSlug: SHIP_SLUG, event: ev });

    const dags = api.list();
    assert.equal(dags.length, 1, "DAG created despite nested ```ts fence");
    const dag = dags[0]!;
    assert.equal(dag.nodes.length, 2);
    const schemaNode = dag.nodes.find((n) => n.title === "schema")!;
    assert.equal(
      schemaNode.prompt,
      nestedPrompt,
      "node prompt preserved verbatim, including nested ```ts fence",
    );
  });
});

describe("parseDagFromTranscript (unit)", () => {
  function ev(seq: number, text: string): AssistantTextEvent {
    return {
      id: `evt-${seq}`,
      sessionSlug: "any",
      seq,
      turn: 0,
      timestamp: new Date().toISOString(),
      kind: "assistant_text",
      text,
    };
  }

  test("parses dag block whose first node prompt contains nested ```ts code block", () => {
    const nestedPrompt =
      "Update parser:\n```ts\nconst RE = /```dag\\n([\\s\\S]*?)```/g;\nconsole.log(RE);\n```\nThen run tests.";
    const block = JSON.stringify({
      title: "Fix dag parser",
      goal: "Handle nested code fences inside node prompts",
      nodes: [
        { title: "parser", prompt: nestedPrompt, dependsOn: [] },
        { title: "tests", prompt: "add fixtures", dependsOn: ["parser"] },
      ],
    });
    const text = `Here is the plan.\n\n\`\`\`dag\n${block}\n\`\`\`\n`;

    const parsed = parseDagFromTranscript([ev(27, text)]);
    assert.ok(parsed, "parser returns a DAG, not null");
    assert.equal(parsed!.title, "Fix dag parser");
    assert.equal(parsed!.nodes.length, 2);
    assert.equal(parsed!.nodes[0]!.title, "parser");
    assert.equal(
      parsed!.nodes[0]!.prompt,
      nestedPrompt,
      "first node prompt is intact, including the nested ```ts fence",
    );
    assert.deepEqual(parsed!.nodes[0]!.dependsOn, []);
    assert.deepEqual(parsed!.nodes[1]!.dependsOn, ["parser"]);
  });

  test("parses dag block with multiple nested fences across several nodes", () => {
    const block = JSON.stringify({
      title: "T",
      goal: "G",
      nodes: [
        { title: "a", prompt: "first ```ts\nconst x = 1;\n``` end", dependsOn: [] },
        { title: "b", prompt: "second ```js\nlet y = 2;\n``` end", dependsOn: ["a"] },
        { title: "c", prompt: "third ```sh\necho hi\n``` end", dependsOn: ["b"] },
      ],
    });
    const text = `\`\`\`dag\n${block}\n\`\`\``;
    const parsed = parseDagFromTranscript([ev(1, text)]);
    assert.ok(parsed);
    assert.equal(parsed!.nodes.length, 3);
    assert.match(parsed!.nodes[0]!.prompt, /```ts/);
    assert.match(parsed!.nodes[1]!.prompt, /```js/);
    assert.match(parsed!.nodes[2]!.prompt, /```sh/);
  });

  test("returns null when no dag fence is present", () => {
    assert.equal(parseDagFromTranscript([ev(0, "no fence here")]), null);
  });

  test("returns null when dag fence has malformed JSON", () => {
    const text = "```dag\n{ not valid json\n```";
    assert.equal(parseDagFromTranscript([ev(0, text)]), null);
  });

  test("plain dag block without nested fences still parses (regression)", () => {
    const block = JSON.stringify({
      title: "Plain",
      goal: "g",
      nodes: [{ title: "n", prompt: "do n", dependsOn: [] }],
    });
    const text = `\`\`\`dag\n${block}\n\`\`\``;
    const parsed = parseDagFromTranscript([ev(0, text)]);
    assert.ok(parsed);
    assert.equal(parsed!.title, "Plain");
    assert.equal(parsed!.nodes[0]!.prompt, "do n");
  });
});
