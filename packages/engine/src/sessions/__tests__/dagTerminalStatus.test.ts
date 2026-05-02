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
} from "../../providers/provider.js";
import { registerProvider } from "../../providers/registry.js";
import type { EngineContext } from "../../context.js";

const DAG_TERMINAL_TEST_PROVIDER = "dag-terminal-status-test";

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

const captured: { controls: ControlledHandle[] } = { controls: [] };

const dagTerminalProvider: AgentProvider = {
  name: DAG_TERMINAL_TEST_PROVIDER,
  async spawn() {
    const ctrl = buildControlledHandle();
    captured.controls.push(ctrl);
    return ctrl.handle;
  },
  async resume() {
    const ctrl = buildControlledHandle();
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

registerProvider(dagTerminalProvider);

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
): void {
  db.prepare(`
    INSERT INTO sessions(
      slug, title, prompt, mode, status, attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens,
      stats_cache_read_tokens, stats_cache_creation_tokens,
      stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, worktree_path, created_at, updated_at, pr_draft, metadata
    ) VALUES (
      ?, ?, ?, 'dag-task', ?, '[]', '[]',
      0, 0, 0, 0, 0, 0, 0, 0, ?, ?, datetime('now'), datetime('now'), 0, '{}'
    )
  `).run(slug, "test", "prompt", status, DAG_TERMINAL_TEST_PROVIDER, worktreePath);
}

interface ObservedTerminal {
  slug: string;
  status: string | null;
}

function makeStubCtx(
  registryRef: { current: SessionRegistry | null },
  observed: ObservedTerminal[],
  orderEvents: string[] = [],
): EngineContext {
  return {
    audit: { record: () => {}, list: () => [] },
    dags: {
      onSessionTerminal: async (slug: string) => {
        const session = registryRef.current?.get(slug) ?? null;
        orderEvents.push(`dag:${session?.status ?? "missing"}`);
        observed.push({ slug, status: session?.status ?? null });
      },
    },
    ship: { onTurnCompleted: async () => {} },
    quality: {
      runForSession: async (slug: string) => {
        const session = registryRef.current?.get(slug) ?? null;
        orderEvents.push(`quality:${session?.status ?? "missing"}`);
        return {
          sessionSlug: slug,
          status: "passed",
          checks: [],
          createdAt: new Date().toISOString(),
        };
      },
      getReport: () => null,
    },
    env: {
      host: "127.0.0.1",
      port: 8787,
      token: "test-token",
      provider: DAG_TERMINAL_TEST_PROVIDER,
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

describe("waitForExit handler commits final status before notifying subsystems", () => {
  let db: Database.Database;
  let bus: EventBus;
  let workspaceDir: string;
  const registryRef: { current: SessionRegistry | null } = { current: null };

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "dag-terminal-status-"));
    captured.controls.length = 0;
    registryRef.current = null;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("exit code 0: dags.onSessionTerminal observes status=completed (not running)", async () => {
    const slug = "sess-dag-ok";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });
    insertSession(db, slug, "running", worktree);

    db.prepare(
      `INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
       VALUES (?, ?, ?, 0, 0, '{}', datetime('now'))`,
    ).run(slug, DAG_TERMINAL_TEST_PROVIDER, "ext-ok");

    const observed: ObservedTerminal[] = [];
    const registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx(registryRef, observed),
    });
    registryRef.current = registry;

    await registry.resumeAllActive();
    assert.equal(captured.controls.length, 1);

    const ctrl = captured.controls[0]!;
    ctrl.exit(0);

    await waitFor(() => observed.length >= 1);

    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.slug, slug);
    assert.equal(
      observed[0]!.status,
      "completed",
      `dags.onSessionTerminal must see committed final status, not the pre-terminal 'running'`,
    );

    await waitFor(() => registry.get(slug)?.status === "completed");
  });

  test("exit code non-zero: dags.onSessionTerminal observes status=failed (not running)", async () => {
    const slug = "sess-dag-fail";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });
    insertSession(db, slug, "running", worktree);

    db.prepare(
      `INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
       VALUES (?, ?, ?, 0, 0, '{}', datetime('now'))`,
    ).run(slug, DAG_TERMINAL_TEST_PROVIDER, "ext-fail");

    const observed: ObservedTerminal[] = [];
    const registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx(registryRef, observed),
    });
    registryRef.current = registry;

    await registry.resumeAllActive();
    assert.equal(captured.controls.length, 1);

    const ctrl = captured.controls[0]!;
    ctrl.exit(1);

    await waitFor(() => observed.length >= 1);

    assert.equal(observed.length, 1);
    assert.equal(
      observed[0]!.status,
      "failed",
      `dags.onSessionTerminal must see committed final status, not the pre-terminal 'running'`,
    );

    await waitFor(() => registry.get(slug)?.status === "failed");
  });

  test("exit code 0: quality runs before dags.onSessionTerminal", async () => {
    const slug = "sess-dag-quality-first";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });
    insertSession(db, slug, "running", worktree);

    db.prepare(
      `INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
       VALUES (?, ?, ?, 0, 0, '{}', datetime('now'))`,
    ).run(slug, DAG_TERMINAL_TEST_PROVIDER, "ext-quality-first");

    const observed: ObservedTerminal[] = [];
    const orderEvents: string[] = [];
    const registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx(registryRef, observed, orderEvents),
    });
    registryRef.current = registry;

    await registry.resumeAllActive();
    assert.equal(captured.controls.length, 1);

    const ctrl = captured.controls[0]!;
    ctrl.exit(0);

    await waitFor(() => observed.length >= 1);

    assert.deepEqual(orderEvents, ["quality:completed", "dag:completed"]);
  });

  test("cancelled session: handler returns early without invoking dags.onSessionTerminal", async () => {
    const slug = "sess-dag-cancelled";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });
    insertSession(db, slug, "running", worktree);

    db.prepare(
      `INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
       VALUES (?, ?, ?, 0, 0, '{}', datetime('now'))`,
    ).run(slug, DAG_TERMINAL_TEST_PROVIDER, "ext-cancel");

    const observed: ObservedTerminal[] = [];
    const registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx(registryRef, observed),
    });
    registryRef.current = registry;

    await registry.resumeAllActive();
    assert.equal(captured.controls.length, 1);

    await registry.stop(slug);
    assert.equal(registry.get(slug)?.status, "cancelled");

    await waitFor(() => {
      const handles = (registry as unknown as { handles: Map<string, ProviderHandle> }).handles;
      return !handles.has(slug);
    });

    assert.equal(observed.length, 0, "cancelled sessions skip dag terminal handler");
    assert.equal(registry.get(slug)?.status, "cancelled", "status stays cancelled");
  });
});
