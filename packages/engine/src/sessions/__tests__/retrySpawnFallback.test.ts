import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventBus } from "../../bus/eventBus.js";
import { SessionRegistry } from "../registry.js";
import { createLogger } from "../../logger.js";
import { migrations } from "../../store/migrations.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderHandle,
  ProviderResumeOpts,
  ProviderSpawnOpts,
  ParseStreamState,
} from "../../providers/provider.js";
import { registerProvider } from "../../providers/registry.js";
import type { EngineContext } from "../../context.js";
import type { AttentionFlag } from "@minions/shared";

const STALE_MARKER_PROVIDER_NAME = "stale-marker-fallback-test";

function buildHandle(): ProviderHandle {
  let resolved = false;
  let exitResolve: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    exitResolve = r;
  });
  return {
    pid: undefined,
    externalId: "rehydrated-ext",
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
}

const captured = {
  resumes: [] as ProviderResumeOpts[],
  spawns: [] as ProviderSpawnOpts[],
};

let throwStaleMarkerOnResume = true;

const fallbackTestProvider: AgentProvider = {
  name: STALE_MARKER_PROVIDER_NAME,
  async spawn(opts) {
    captured.spawns.push(opts);
    return buildHandle();
  },
  async resume(opts) {
    captured.resumes.push(opts);
    if (throwStaleMarkerOnResume) {
      throw new Error(
        "No deferred tool marker found in the resumed session. The marker file in .minions is missing.",
      );
    }
    return buildHandle();
  },
  parseStreamChunk(_buf: string, state: ParseStreamState) {
    return { events: [], state };
  },
  detectQuotaError(_text: string) {
    return false;
  },
};

registerProvider(fallbackTestProvider);

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

function insertFailedSession(
  db: Database.Database,
  slug: string,
  worktreePath: string,
  attention: AttentionFlag[],
): void {
  db.prepare(`
    INSERT INTO sessions(
      slug, title, prompt, mode, status, attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens,
      stats_cache_read_tokens, stats_cache_creation_tokens,
      stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, worktree_path, created_at, updated_at, pr_draft, metadata
    ) VALUES (
      ?, ?, ?, 'task', 'failed', ?, '[]',
      0, 0, 0, 0, 0, 0, 0, 0, ?, ?, datetime('now'), datetime('now'), 0, '{}'
    )
  `).run(slug, "test", "original-prompt", JSON.stringify(attention), STALE_MARKER_PROVIDER_NAME, worktreePath);
}

interface AuditCall {
  actor: string;
  action: string;
  target?: { kind: string; id: string };
  detail?: Record<string, unknown>;
}

function makeStubCtx(audits: AuditCall[]): EngineContext {
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
    env: { host: "127.0.0.1", port: 8787, token: "test-token" },
    memory: { renderPreamble: () => "PREAMBLE-CONTENT" },
    resource: { latest: () => ({}) },
    runtime: {
      schema: () => ({ groups: [], fields: [] }),
      values: () => ({}),
      effective: () => ({}),
      update: async () => {},
    },
  } as unknown as EngineContext;
}

describe("continueWithQueuedReplies stale-marker fallback", () => {
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let workspaceDir: string;
  let audits: AuditCall[];

  beforeEach(() => {
    db = makeDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "retry-fallback-"));
    captured.resumes.length = 0;
    captured.spawns.length = 0;
    throwStaleMarkerOnResume = true;
    audits = [];
    registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx(audits),
    });
    registry.stopStuckPendingSweep();
  });

  afterEach(() => {
    db.close();
  });

  test("falls back to spawn --resume when resume throws stale-marker, riding the queued reply via additionalPrompt", async () => {
    const slug = "sess-fallback";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });

    insertFailedSession(db, slug, worktree, [
      {
        kind: "manual_intervention",
        message: "resume failed: stale marker after engine restart; please retry or re-dispatch",
        raisedAt: new Date().toISOString(),
      },
    ]);
    db.prepare(
      `INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
       VALUES (?, ?, ?, 0, 0, '{}', datetime('now'))`,
    ).run(slug, STALE_MARKER_PROVIDER_NAME, "ext-rehydrate-me");

    await registry.reply(slug, "TAG-RETRY-XYZ");

    const kicked = await registry.kickReplyQueue(slug);
    assert.equal(kicked, true, "kickReplyQueue should report success");

    assert.equal(captured.resumes.length, 1, "resume was attempted once and threw stale-marker");
    assert.equal(captured.spawns.length, 1, "spawn fallback fired exactly once");

    const spawnOpts = captured.spawns[0]!;
    assert.equal(spawnOpts.externalId, "ext-rehydrate-me", "spawn fallback rehydrates via --resume <externalId>");
    assert.ok(
      (spawnOpts.additionalPrompt ?? "").includes("TAG-RETRY-XYZ"),
      "queued reply rides the spawn fallback as additionalPrompt",
    );
    assert.equal(spawnOpts.prompt, "original-prompt", "fallback re-uses the original session prompt");

    const auditFallback = audits.find((a) => a.action === "session.retry.spawn-fallback");
    assert.ok(auditFallback, "session.retry.spawn-fallback must be recorded");
    assert.equal(auditFallback?.target?.id, slug);

    const row = db
      .prepare(`SELECT status, attention FROM sessions WHERE slug = ?`)
      .get(slug) as { status: string; attention: string };
    assert.equal(row.status, "running", "session status is moved back to running after fallback");
    const attention = JSON.parse(row.attention) as AttentionFlag[];
    assert.equal(
      attention.length,
      0,
      "stale-marker manual_intervention flag is cleared after the fallback fires",
    );

    const queueRows = db
      .prepare(
        `SELECT payload FROM reply_queue WHERE session_slug = ? AND delivered_at IS NULL`,
      )
      .all(slug) as Array<{ payload: string }>;
    assert.equal(queueRows.length, 0, "queue is drained on confirm after the fallback succeeds");
  });

  test("non-stale-marker resume errors still propagate (no fallback) and the queue is released", async () => {
    const slug = "sess-other-err";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });

    insertFailedSession(db, slug, worktree, []);
    db.prepare(
      `INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
       VALUES (?, ?, ?, 0, 0, '{}', datetime('now'))`,
    ).run(slug, STALE_MARKER_PROVIDER_NAME, "ext-other");

    // Override provider.resume to throw a non-stale-marker error this time.
    const original = fallbackTestProvider.resume;
    fallbackTestProvider.resume = async (opts) => {
      captured.resumes.push(opts);
      throw new Error("network blew up");
    };

    try {
      await registry.reply(slug, "should-not-be-spawned");
      await assert.rejects(
        () => registry.kickReplyQueue(slug),
        /network blew up/,
      );
      assert.equal(captured.spawns.length, 0, "fallback must NOT fire on unrelated errors");
      const queueRows = db
        .prepare(
          `SELECT payload FROM reply_queue WHERE session_slug = ? AND delivered_at IS NULL`,
        )
        .all(slug) as Array<{ payload: string }>;
      assert.equal(queueRows.length, 1, "queue is released back to pending so the next kick can retry");
    } finally {
      fallbackTestProvider.resume = original;
    }
  });
});
