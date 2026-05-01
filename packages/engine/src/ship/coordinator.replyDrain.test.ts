import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventBus } from "../bus/eventBus.js";
import { KeyedMutex } from "../util/mutex.js";
import { createLogger } from "../logger.js";
import { migrations } from "../store/migrations.js";
import { SessionRegistry } from "../sessions/registry.js";
import { ShipCoordinator } from "./coordinator.js";
import { registerProvider } from "../providers/registry.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderHandle,
  ProviderResumeOpts,
  ProviderSpawnOpts,
  ParseStreamState,
} from "../providers/provider.js";
import type { EngineContext } from "../context.js";

const REPLY_DRAIN_PROVIDER_NAME = "ship-replydrain-test";

interface CapturedResume {
  additionalPrompt: string | undefined;
}

const captured = {
  resumes: [] as CapturedResume[],
};

const exitControls: Array<(code?: number) => void> = [];

function buildControlledHandle(): { handle: ProviderHandle; exit: (code?: number) => void } {
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

const replyDrainProvider: AgentProvider = {
  name: REPLY_DRAIN_PROVIDER_NAME,
  async spawn(_opts: ProviderSpawnOpts) {
    const { handle, exit } = buildControlledHandle();
    exitControls.push(exit);
    return handle;
  },
  async resume(opts: ProviderResumeOpts) {
    captured.resumes.push({ additionalPrompt: opts.additionalPrompt });
    const { handle, exit } = buildControlledHandle();
    exitControls.push(exit);
    return handle;
  },
  parseStreamChunk(_buf: string, state: ParseStreamState) {
    return { events: [], state };
  },
  detectQuotaError(_text: string) {
    return false;
  },
};

registerProvider(replyDrainProvider);

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

function insertShipSession(db: Database.Database, slug: string, stage: string, worktree: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sessions(
      slug, title, prompt, mode, status, ship_stage, repo_id, branch, base_branch,
      worktree_path, parent_slug, root_slug, pr_number, pr_url, pr_state, pr_draft,
      pr_base, pr_head, pr_title, attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens,
      stats_cache_read_tokens, stats_cache_creation_tokens,
      stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, model_hint, created_at, updated_at, started_at, completed_at,
      last_turn_at, dag_id, dag_node_id, loop_id, variant_of, metadata
    ) VALUES (
      ?, ?, ?, 'ship', 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
  `).run(
    slug, "ship-test", "do the work", stage,
    null, null, null, worktree, null, null,
    null, null, null, 0, null, null, null,
    "[]", "[]",
    0, 0, 0, 0, 0, 0, 0, 0,
    REPLY_DRAIN_PROVIDER_NAME, null,
    now, now, now, null, null,
    null, null, null, null,
    "{}",
  );
  db.prepare(`
    INSERT INTO ship_state(session_slug, stage, notes, updated_at) VALUES (?, ?, '[]', ?)
  `).run(slug, stage, now);
  db.prepare(`
    INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
    VALUES (?, ?, ?, 0, 0, '{}', ?)
  `).run(slug, REPLY_DRAIN_PROVIDER_NAME, `ext-${slug}`, now);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function insertAssistantTextEvent(db: Database.Database, slug: string, text: string): void {
  const seq = ((db
    .prepare(`SELECT COALESCE(MAX(seq), -1) AS s FROM transcript_events WHERE session_slug = ?`)
    .get(slug) as { s: number }).s) + 1;
  db.prepare(`
    INSERT INTO transcript_events(id, session_slug, seq, turn, kind, body, timestamp)
    VALUES (?, ?, ?, 0, 'assistant_text', ?, ?)
  `).run(`ev-${seq}-${slug}`, slug, seq, JSON.stringify({ text }), new Date().toISOString());
}

describe("ShipCoordinator + replyQueue drain integration", () => {
  let workspaceDir: string;
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let coordinator: ShipCoordinator;
  let ctx: EngineContext;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-replydrain-"));
    db = makeDb();
    bus = new EventBus();
    captured.resumes.length = 0;
    exitControls.length = 0;

    ctx = {
      env: {} as EngineContext["env"],
      log: createLogger("error"),
      db,
      bus,
      mutex: new KeyedMutex(),
      workspaceDir,
      audit: { record: () => {}, list: () => [] },
      dags: {
        list: () => [],
        get: () => null,
        splitNode: async () => ({} as never),
        onSessionTerminal: async () => {},
        retry: async () => {},
        cancel: async () => {},
        forceLand: async () => {},
      },
      ship: {
        advance: async () => {},
        onTurnCompleted: async () => {},
        reconcileOnBoot: async () => {},
      },
      readiness: {
        compute: async () => ({} as never),
        summary: () => ({} as never),
      },
    } as unknown as EngineContext;

    registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx,
    });

    (ctx as unknown as { sessions: unknown }).sessions = {
      get: (slug: string) => registry.get(slug),
      transcript: (slug: string) => registry.transcript(slug),
      reply: (slug: string, text: string) => registry.reply(slug, text),
    };

    coordinator = new ShipCoordinator(db, ctx, createLogger("error"));
    (ctx as unknown as { ship: EngineContext["ship"] }).ship = {
      onTurnCompleted: (s: string) => coordinator.onTurnCompleted(s),
      advance: (s: string, to?: import("@minions/shared").ShipStage, n?: string) => coordinator.advance(s, to, n),
      reconcileOnBoot: () => coordinator.reconcileOnBoot(),
    };
  });

  afterEach(() => {
    db.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("queued operator reply is delivered alongside stage directive on next resume", async () => {
    const slug = "ship-drain-1";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });
    insertShipSession(db, slug, "think", worktree);

    insertAssistantTextEvent(
      db,
      slug,
      "thoroughly thinking about the problem. ".repeat(20),
    );

    await registry.resumeAllActive();
    assert.equal(captured.resumes.length, 1, "initial resume from resumeAllActive");
    assert.equal(captured.resumes[0]?.additionalPrompt, undefined);

    const operatorTag = "OPERATOR-XY9-TAG";
    await registry.reply(slug, `please also consider ${operatorTag}`);

    const queueRows = db
      .prepare(`SELECT payload FROM reply_queue WHERE session_slug = ? AND delivered_at IS NULL`)
      .all(slug) as Array<{ payload: string }>;
    assert.equal(queueRows.length, 1);
    assert.ok(queueRows[0]?.payload.includes(operatorTag));

    const firstExit = exitControls[0];
    assert.ok(firstExit);
    firstExit(0);

    await waitFor(() => captured.resumes.length >= 2);

    assert.ok(captured.resumes.length >= 2, "drain hook should resume with queued items");
    const lastResume = captured.resumes[captured.resumes.length - 1];
    const additional = lastResume?.additionalPrompt ?? "";

    assert.ok(
      additional.includes(operatorTag),
      `operator reply tag should reach the resume's additionalPrompt (got: ${additional})`,
    );
    assert.ok(
      additional.includes("Ship stage: plan"),
      `stage directive should also reach the resume's additionalPrompt (got: ${additional})`,
    );

    const stageRow = db
      .prepare(`SELECT stage FROM ship_state WHERE session_slug = ?`)
      .get(slug) as { stage: string } | undefined;
    assert.equal(stageRow?.stage, "plan", "ship stage advanced to plan");

    const queueAfter = db
      .prepare(`SELECT COUNT(*) AS c FROM reply_queue WHERE session_slug = ? AND delivered_at IS NULL`)
      .get(slug) as { c: number };
    assert.equal(queueAfter.c, 0, "queue is fully drained after delivery");
  });
});
