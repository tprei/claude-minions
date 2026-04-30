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
  ParseStreamState,
} from "../../providers/provider.js";
import { registerProvider } from "../../providers/registry.js";
import type { EngineContext } from "../../context.js";

const TERMINAL_STATUS_TEST_PROVIDER = "terminal-status-test";

interface ControlledHandle {
  handle: ProviderHandle;
  exit: (code?: number) => void;
}

function buildControlledHandle(): ControlledHandle {
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

const exitControls: ControlledHandle[] = [];

const terminalStatusProvider: AgentProvider = {
  name: TERMINAL_STATUS_TEST_PROVIDER,
  async spawn(_opts) {
    const ctrl = buildControlledHandle();
    exitControls.push(ctrl);
    return ctrl.handle;
  },
  async resume(_opts) {
    const ctrl = buildControlledHandle();
    exitControls.push(ctrl);
    return ctrl.handle;
  },
  parseStreamChunk(_buf: string, state: ParseStreamState) {
    return { events: [], state };
  },
  detectQuotaError(_text: string) {
    return false;
  },
};

registerProvider(terminalStatusProvider);

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

function insertRunningSession(
  db: Database.Database,
  slug: string,
  worktreePath: string,
): void {
  db.prepare(`
    INSERT INTO sessions(
      slug, title, prompt, mode, status, attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens,
      stats_cache_read_tokens, stats_cache_creation_tokens,
      stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, worktree_path, created_at, updated_at, pr_draft, metadata
    ) VALUES (
      ?, ?, ?, 'task', 'running', '[]', '[]',
      0, 0, 0, 0, 0, 0, 0, 0, ?, ?, datetime('now'), datetime('now'), 0, '{}'
    )
  `).run(slug, "test", "prompt", TERMINAL_STATUS_TEST_PROVIDER, worktreePath);
}

interface DagObservation {
  slug: string;
  observedStatus: string | undefined;
}

function makeCapturingCtx(
  observations: DagObservation[],
  registryRef: { current: SessionRegistry | null },
): EngineContext {
  return {
    audit: { record: () => {}, list: () => [] },
    dags: {
      onSessionTerminal: async (slug: string) => {
        const session = registryRef.current?.get(slug);
        observations.push({ slug, observedStatus: session?.status });
      },
    },
    ship: { onTurnCompleted: async () => {} },
    env: {
      host: "127.0.0.1",
      port: 8787,
      token: "test-token",
      provider: TERMINAL_STATUS_TEST_PROVIDER,
    },
    memory: { renderPreamble: () => "" },
    runtime: { effective: () => ({}) },
  } as unknown as EngineContext;
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

describe("SessionRegistry terminal-status commit ordering", () => {
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let workspaceDir: string;
  let observations: DagObservation[];

  beforeEach(async () => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-status-"));
    exitControls.length = 0;
    observations = [];
    const registryRef: { current: SessionRegistry | null } = { current: null };
    registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeCapturingCtx(observations, registryRef),
    });
    registryRef.current = registry;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("exit code 0 commits 'completed' before dag-terminal handler reads status", async () => {
    const slug = "sess-completed";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });
    insertRunningSession(db, slug, worktree);

    await registry.resumeAllActive();
    assert.equal(exitControls.length, 1);

    exitControls[0]!.exit(0);

    await waitFor(() => observations.length >= 1);

    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.slug, slug);
    assert.equal(
      observations[0]?.observedStatus,
      "completed",
      "dag-terminal handler must observe 'completed' (not the pre-terminal 'running')",
    );

    const row = db.prepare(`SELECT status FROM sessions WHERE slug = ?`).get(slug) as
      | { status: string }
      | undefined;
    assert.equal(row?.status, "completed");
  });

  test("non-zero exit commits 'failed' before dag-terminal handler reads status", async () => {
    const slug = "sess-failed";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });
    insertRunningSession(db, slug, worktree);

    await registry.resumeAllActive();
    assert.equal(exitControls.length, 1);

    exitControls[0]!.exit(1);

    await waitFor(() => observations.length >= 1);

    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.slug, slug);
    assert.equal(
      observations[0]?.observedStatus,
      "failed",
      "dag-terminal handler must observe 'failed' (not the pre-terminal 'running')",
    );

    const row = db.prepare(`SELECT status FROM sessions WHERE slug = ?`).get(slug) as
      | { status: string }
      | undefined;
    assert.equal(row?.status, "failed");
  });

  test("cancelled session does not invoke dag-terminal handler", async () => {
    const slug = "sess-cancelled";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });
    insertRunningSession(db, slug, worktree);

    await registry.resumeAllActive();
    assert.equal(exitControls.length, 1);

    db.prepare(
      `UPDATE sessions SET status = 'cancelled', completed_at = datetime('now') WHERE slug = ?`,
    ).run(slug);

    exitControls[0]!.exit(0);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(
      observations.length,
      0,
      "cancelled status short-circuits before the terminal handler fires",
    );

    const row = db.prepare(`SELECT status FROM sessions WHERE slug = ?`).get(slug) as
      | { status: string }
      | undefined;
    assert.equal(row?.status, "cancelled", "cancelled status must be preserved");
  });
});
