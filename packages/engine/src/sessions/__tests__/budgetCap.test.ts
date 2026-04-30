import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventBus } from "../../bus/eventBus.js";
import { SessionRegistry } from "../registry.js";
import { TranscriptCollector } from "../transcriptCollector.js";
import { createLogger } from "../../logger.js";
import { migrations } from "../../store/migrations.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderHandle,
  ProviderResumeOpts,
  ProviderSpawnOpts,
} from "../../providers/provider.js";
import { registerProvider } from "../../providers/registry.js";
import type { EngineContext } from "../../context.js";

const BUDGET_CAP_TEST_PROVIDER = "budget-cap-test";

interface ControlledHandle {
  handle: ProviderHandle;
  exit: (code?: number) => void;
}

function buildEventfulHandle(events: ProviderEvent[]): ControlledHandle {
  let resolved = false;
  let exitResolve: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    exitResolve = r;
  });
  const handle: ProviderHandle = {
    pid: undefined,
    externalId: undefined,
    kill(_signal: NodeJS.Signals) {
      if (resolved) return;
      resolved = true;
      exitResolve({ code: null, signal: _signal });
    },
    write(_text: string) {},
    async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
      for (const ev of events) yield ev;
      await exitPromise;
    },
    waitForExit() {
      return exitPromise;
    },
  };
  return {
    handle,
    exit: (code = 0) => {
      if (resolved) return;
      resolved = true;
      exitResolve({ code, signal: null });
    },
  };
}

const captured: {
  spawns: ProviderSpawnOpts[];
  resumes: ProviderResumeOpts[];
  controls: ControlledHandle[];
  nextResumeEvents: ProviderEvent[] | null;
} = {
  spawns: [],
  resumes: [],
  controls: [],
  nextResumeEvents: null,
};

const budgetCapTestProvider: AgentProvider = {
  name: BUDGET_CAP_TEST_PROVIDER,
  async spawn(opts) {
    captured.spawns.push(opts);
    const ctrl = buildEventfulHandle([]);
    captured.controls.push(ctrl);
    return ctrl.handle;
  },
  async resume(opts) {
    captured.resumes.push(opts);
    const events = captured.nextResumeEvents ?? [];
    const ctrl = buildEventfulHandle(events);
    captured.controls.push(ctrl);
    return ctrl.handle;
  },
  parseStreamChunk(_buf, state) {
    return { events: [], state };
  },
  detectQuotaError() {
    return false;
  },
};

registerProvider(budgetCapTestProvider);

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

function insertSession(
  db: Database.Database,
  slug: string,
  status: string,
  worktreePath: string,
  provider: string,
  costBudgetUsd: number | null,
): void {
  db.prepare(`
    INSERT INTO sessions(
      slug, title, prompt, mode, status, attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens,
      stats_cache_read_tokens, stats_cache_creation_tokens,
      stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, worktree_path, created_at, updated_at, pr_draft, metadata,
      cost_budget_usd
    ) VALUES (
      ?, ?, ?, 'task', ?, '[]', '[]',
      0, 0, 0, 0, 0, 0, 0, 0, ?, ?, datetime('now'), datetime('now'), 0, '{}',
      ?
    )
  `).run(slug, "test", "prompt", status, provider, worktreePath, costBudgetUsd);
}

interface AuditEntry {
  actor: string;
  action: string;
  target?: { kind: string; id: string };
  detail?: Record<string, unknown>;
}

function makeStubCtx(audits: AuditEntry[]): EngineContext {
  return {
    audit: {
      record: (
        actor: string,
        action: string,
        target?: { kind: string; id: string },
        detail?: Record<string, unknown>,
      ) => {
        audits.push({ actor, action, target, detail });
      },
      list: () => [],
    },
    dags: { onSessionTerminal: async () => {} },
    ship: { onTurnCompleted: async () => {} },
    env: {
      host: "127.0.0.1",
      port: 8787,
      token: "test-token",
      provider: BUDGET_CAP_TEST_PROVIDER,
    },
    memory: { renderPreamble: () => "" },
    runtime: { effective: () => ({}) },
  } as unknown as EngineContext;
}

function wireSessionsCtx(ctx: EngineContext, registry: SessionRegistry): void {
  (ctx as unknown as { sessions: EngineContext["sessions"] }).sessions = {
    get: (slug: string) => registry.get(slug),
    markWaitingInput: (slug: string, reason?: string) => registry.markWaitingInput(slug, reason),
    appendAttention: (slug: string, flag: import("@minions/shared").AttentionFlag) =>
      registry.appendAttention(slug, flag),
  } as unknown as EngineContext["sessions"];
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("budget cap plumbing", () => {
  let db: Database.Database;
  let bus: EventBus;
  let workspaceDir: string;

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-cap-"));
    captured.spawns.length = 0;
    captured.resumes.length = 0;
    captured.controls.length = 0;
    captured.nextResumeEvents = null;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("provider costUsd merges into session.stats.costUsd across turns", async () => {
    const slug = "sess-cost-merge";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });
    insertSession(db, slug, "running", worktree, BUDGET_CAP_TEST_PROVIDER, null);

    const collector = new TranscriptCollector({
      db,
      bus,
      log: createLogger("error"),
    });

    const events: ProviderEvent[] = [
      { kind: "turn_started" },
      { kind: "turn_completed", outcome: "success", costUsd: 0.25, usage: { inputTokens: 100, outputTokens: 50 } },
      { kind: "turn_started" },
      { kind: "turn_completed", outcome: "success", costUsd: 0.75, usage: { inputTokens: 200, outputTokens: 80 } },
    ];

    async function* gen(): AsyncIterable<ProviderEvent> {
      for (const ev of events) yield ev;
    }

    await collector.collect(slug, gen());

    const row = db
      .prepare(
        `SELECT stats_cost_usd, stats_input_tokens, stats_output_tokens, stats_turns
         FROM sessions WHERE slug = ?`,
      )
      .get(slug) as {
        stats_cost_usd: number;
        stats_input_tokens: number;
        stats_output_tokens: number;
        stats_turns: number;
      };

    assert.equal(row.stats_turns, 2);
    assert.ok(Math.abs(row.stats_cost_usd - 1.0) < 1e-9, `expected 1.0, got ${row.stats_cost_usd}`);
    assert.equal(row.stats_input_tokens, 300);
    assert.equal(row.stats_output_tokens, 130);
  });

  test("cap trigger transitions to waiting_input + appends budget_exceeded flag + audits session.budget.exceeded", async () => {
    const slug = "sess-cap-trigger";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });
    insertSession(db, slug, "running", worktree, BUDGET_CAP_TEST_PROVIDER, 0.5);

    const audits: AuditEntry[] = [];
    const ctx = makeStubCtx(audits);
    const registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx,
    });
    wireSessionsCtx(ctx, registry);

    const collector = new TranscriptCollector({
      db,
      bus,
      log: createLogger("error"),
      ctx,
    });

    const events: ProviderEvent[] = [
      { kind: "turn_started" },
      { kind: "turn_completed", outcome: "success", costUsd: 0.6 },
    ];

    async function* gen(): AsyncIterable<ProviderEvent> {
      for (const ev of events) yield ev;
    }

    await collector.collect(slug, gen());

    const sess = registry.get(slug);
    assert.ok(sess);
    assert.equal(sess!.status, "waiting_input", "status must flip to waiting_input");
    assert.equal(sess!.attention.length, 1, "exactly one attention flag added");
    assert.equal(sess!.attention[0]!.kind, "budget_exceeded");

    const budgetAudits = audits.filter((a) => a.action === "session.budget.exceeded");
    assert.equal(budgetAudits.length, 1, "exactly one budget audit recorded");
    assert.equal(budgetAudits[0]!.target?.id, slug);
    assert.equal(budgetAudits[0]!.detail?.["costBudgetUsd"], 0.5);
    assert.ok(
      typeof budgetAudits[0]!.detail?.["costUsd"] === "number" &&
        (budgetAudits[0]!.detail?.["costUsd"] as number) >= 0.6,
    );
  });

  test("kickReplyQueue is a no-op while budget_exceeded flag is present", async () => {
    const slug = "sess-kick-blocked";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });
    insertSession(db, slug, "waiting_input", worktree, BUDGET_CAP_TEST_PROVIDER, 0.5);

    db.prepare(
      `INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
       VALUES (?, ?, ?, 0, 0, '{}', datetime('now'))`,
    ).run(slug, BUDGET_CAP_TEST_PROVIDER, "ext-blocked");

    const audits: AuditEntry[] = [];
    const ctx = makeStubCtx(audits);
    const registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx,
    });
    wireSessionsCtx(ctx, registry);

    registry.appendAttention(slug, {
      kind: "budget_exceeded",
      message: "test cap exceeded",
      raisedAt: new Date().toISOString(),
    });

    db.prepare(
      `INSERT INTO reply_queue(id, session_slug, payload, queued_at) VALUES (?, ?, ?, ?)`,
    ).run("rq-1", slug, "follow up", new Date().toISOString());

    const result = await registry.kickReplyQueue(slug);
    assert.equal(result, false, "kick must no-op while flag is present");
    assert.equal(captured.resumes.length, 0, "provider.resume must not be called");

    const pending = db
      .prepare(`SELECT COUNT(*) AS c FROM reply_queue WHERE session_slug = ? AND delivered_at IS NULL`)
      .get(slug) as { c: number };
    assert.equal(pending.c, 1, "queued reply must remain pending");
  });

  test("clearing the flag and re-kicking drains queued replies", async () => {
    const slug = "sess-kick-cleared";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });
    insertSession(db, slug, "waiting_input", worktree, BUDGET_CAP_TEST_PROVIDER, 1.0);

    db.prepare(
      `INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
       VALUES (?, ?, ?, 0, 0, '{}', datetime('now'))`,
    ).run(slug, BUDGET_CAP_TEST_PROVIDER, "ext-cleared");

    const audits: AuditEntry[] = [];
    const ctx = makeStubCtx(audits);
    const registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx,
    });
    wireSessionsCtx(ctx, registry);

    registry.appendAttention(slug, {
      kind: "budget_exceeded",
      message: "test cap exceeded",
      raisedAt: new Date().toISOString(),
    });

    db.prepare(
      `INSERT INTO reply_queue(id, session_slug, payload, queued_at) VALUES (?, ?, ?, ?)`,
    ).run("rq-1", slug, "follow up", new Date().toISOString());

    let blocked = await registry.kickReplyQueue(slug);
    assert.equal(blocked, false);
    assert.equal(captured.resumes.length, 0);

    db.prepare(`UPDATE sessions SET attention = '[]' WHERE slug = ?`).run(slug);

    captured.nextResumeEvents = [
      { kind: "turn_started" },
      { kind: "assistant_text", text: "drained" },
      { kind: "turn_completed", outcome: "success" },
    ];

    const drained = await registry.kickReplyQueue(slug);
    assert.equal(drained, true, "kick must drain after flag is cleared");
    assert.equal(captured.resumes.length, 1, "provider.resume must be called once");
    assert.ok(
      (captured.resumes[0]?.additionalPrompt ?? "").includes("follow up"),
      "queued payload should be passed to resume",
    );

    const ctrl = captured.controls[0]!;
    ctrl.exit(0);

    await waitFor(() => {
      const remaining = db
        .prepare(`SELECT COUNT(*) AS c FROM reply_queue WHERE session_slug = ? AND delivered_at IS NULL`)
        .get(slug) as { c: number };
      return remaining.c === 0;
    });
  });
});
