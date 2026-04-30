import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import type { AuditEvent, FeatureFlag, RepoBinding } from "@minions/shared";
import { migrations } from "../store/migrations.js";
import { EventBus } from "../bus/eventBus.js";
import { KeyedMutex } from "../util/mutex.js";
import { createLogger } from "../logger.js";
import type { EngineContext } from "../context.js";
import type { EngineEnv } from "../env.js";
import type { SubsystemDeps } from "../wiring.js";
import { AuditRepo } from "../store/repos/auditRepo.js";
import { SessionRegistry } from "./registry.js";
import { createDagSubsystem } from "../dag/index.js";
import { createShipSubsystem } from "../ship/index.js";
import { createLoopsSubsystem } from "../loops/index.js";
import { newSlug } from "../util/ids.js";
import { registerProvider } from "../providers/registry.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderHandle,
  ParseStreamState,
} from "../providers/provider.js";

const RESUME_TEST_PROVIDER_NAME = "resume-test";

function buildSilentHandle(externalId: string): ProviderHandle {
  let resolved = false;
  let exitResolve: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    exitResolve = r;
  });

  return {
    pid: undefined,
    externalId,
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

const resumeTestProvider: AgentProvider = {
  name: RESUME_TEST_PROVIDER_NAME,
  async spawn(opts) {
    return buildSilentHandle(`resume-test-${opts.sessionSlug}`);
  },
  async resume(opts) {
    return buildSilentHandle(opts.externalId ?? `resume-test-${opts.sessionSlug}`);
  },
  parseStreamChunk(_buf: string, state: ParseStreamState) {
    return { events: [], state };
  },
  detectQuotaError(_text: string) {
    return false;
  },
};

registerProvider(resumeTestProvider);

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) {
    db.exec(m.sql);
  }
  return db;
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "minions-resume-"));
}

interface AuditFn {
  record: EngineContext["audit"]["record"];
  list: EngineContext["audit"]["list"];
}

function makeAudit(db: Database.Database): AuditFn {
  const repo = new AuditRepo(db);
  return {
    record: (actor, action, target, detail) => repo.record(actor, action, target, detail),
    list: (limit) => repo.list(limit),
  };
}

function listAudit(db: Database.Database): AuditEvent[] {
  return new AuditRepo(db).list(500);
}

function insertSessionRow(
  db: Database.Database,
  args: {
    slug: string;
    mode: string;
    status: string;
    worktreePath?: string | null;
    shipStage?: string | null;
    provider?: string;
  },
): void {
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
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
  `).run(
    args.slug, "Test", "test prompt", args.mode, args.status, args.shipStage ?? null,
    null, null, null,
    args.worktreePath ?? null, null, null,
    null, null, null, 0, null, null, null,
    "[]", "[]",
    0, 0, 0, 0, 0, 0, 0, 0,
    args.provider ?? "mock", null,
    now, now, now, null, null,
    null, null, null, null,
    "{}",
  );
}

function makeEnv(workspaceDir: string): EngineEnv {
  return {
    port: 0,
    host: "127.0.0.1",
    token: "test",
    corsOrigins: [],
    workspace: workspaceDir,
    provider: "mock",
    logLevel: "error",
    vapid: null,
    githubApp: null,
    resourceSampleSec: 60,
    loopTickSec: 60,
    loopReservedInteractive: 0,
    ssePingSec: 60,
    apiVersion: "1",
    libraryVersion: "0.0.0-test",
    webDist: null,
  };
}

function makeCtx(args: {
  db: Database.Database;
  bus: EventBus;
  workspaceDir: string;
  audit: AuditFn;
  sessionsGet?: (slug: string) => unknown;
  sessionsList?: () => unknown[];
}): EngineContext {
  const env = makeEnv(args.workspaceDir);
  const features: FeatureFlag[] = [];
  const repos: RepoBinding[] = [];

  const ctx: Partial<EngineContext> = {
    env,
    log: createLogger("error"),
    db: args.db,
    bus: args.bus,
    mutex: new KeyedMutex(),
    workspaceDir: args.workspaceDir,
    audit: args.audit,
    runtime: {
      schema: () => ({ groups: [], fields: [] }),
      values: () => ({}),
      effective: () => ({}),
      update: async () => {},
    },
    sessions: {
      create: async () => { throw new Error("not used in tests"); },
      get: ((slug: string) => args.sessionsGet?.(slug) ?? null) as EngineContext["sessions"]["get"],
      list: (() => args.sessionsList?.() ?? []) as EngineContext["sessions"]["list"],
      listPaged: () => ({ items: [] }) as never,
      listWithTranscript: () => [],
      transcript: () => [],
      stop: async () => {},
      close: async () => {},
      delete: async () => {},
      reply: async () => {},
      setDagId: () => {},
      markWaitingInput: () => {},
      appendAttention: () => {},
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
    features: () => features,
    repos: () => repos,
    shutdown: async () => {},
  };

  return ctx as EngineContext;
}

function makeDeps(ctx: EngineContext): SubsystemDeps {
  return {
    ctx,
    log: ctx.log,
    env: ctx.env,
    db: ctx.db,
    bus: ctx.bus,
    mutex: ctx.mutex,
    workspaceDir: ctx.workspaceDir,
  };
}

describe("resume on boot", () => {
  test("(a) sessions: resumeAllActive records session.resume audit and re-pipes handle", async () => {
    const db = makeDb();
    const bus = new EventBus();
    const workspaceDir = makeWorkspace();
    const audit = makeAudit(db);

    const ctx = makeCtx({ db, bus, workspaceDir, audit });

    const slug = newSlug();
    const worktreePath = path.join(workspaceDir, slug);
    fs.mkdirSync(worktreePath, { recursive: true });
    insertSessionRow(db, {
      slug,
      mode: "task",
      status: "running",
      worktreePath,
      provider: RESUME_TEST_PROVIDER_NAME,
    });

    const registry = new SessionRegistry({
      db,
      bus,
      log: ctx.log,
      workspaceDir,
      ctx,
    });

    try {
      await registry.resumeAllActive();

      const events = listAudit(db);
      const resumeEvent = events.find(
        (e) => e.action === "session.resume" && e.target?.id === slug,
      );
      assert.ok(resumeEvent, "expected session.resume audit event for slug");
      assert.equal(resumeEvent?.target?.kind, "session");
      assert.equal(resumeEvent?.actor, "system");

      const row = db.prepare(`SELECT status FROM sessions WHERE slug = ?`).get(slug) as
        | { status: string }
        | undefined;
      assert.equal(row?.status, "running", "session should remain running after resume");
    } finally {
      await registry.stop(slug);
    }
  });

  test("(a2) sessions: resumeAllActive marks failed when worktree_path missing", async () => {
    const db = makeDb();
    const bus = new EventBus();
    const workspaceDir = makeWorkspace();
    const audit = makeAudit(db);

    const ctx = makeCtx({ db, bus, workspaceDir, audit });

    const slug = newSlug();
    insertSessionRow(db, { slug, mode: "task", status: "running", worktreePath: null });

    const registry = new SessionRegistry({
      db,
      bus,
      log: ctx.log,
      workspaceDir,
      ctx,
    });

    await registry.resumeAllActive();

    const row = db.prepare(`SELECT status FROM sessions WHERE slug = ?`).get(slug) as
      | { status: string }
      | undefined;
    assert.equal(row?.status, "failed", "session without worktree should be marked failed");

    const events = listAudit(db);
    const skipped = events.find(
      (e) => e.action === "session.resume.skipped" && e.target?.id === slug,
    );
    assert.ok(skipped, "expected session.resume.skipped audit event");
  });

  test("(b) dag: stale running node with missing session is reset to ready", () => {
    const db = makeDb();
    const bus = new EventBus();
    const workspaceDir = makeWorkspace();
    const audit = makeAudit(db);

    const ctx = makeCtx({
      db,
      bus,
      workspaceDir,
      audit,
      sessionsGet: () => null,
    });

    const dagId = newSlug("dag");
    const nodeId = newSlug("node");
    const orphanSlug = newSlug();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO dags(id, title, goal, repo_id, base_branch, root_session_slug, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(dagId, "test dag", "goal", null, null, null, "active", "{}", now, now);

    db.prepare(`
      INSERT INTO dag_nodes(id, dag_id, title, prompt, status, depends_on, session_slug, branch, base_branch,
        pr_number, pr_url, started_at, completed_at, failed_reason, metadata, ord)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nodeId, dagId, "node A", "do A", "running", "[]", orphanSlug, null, null, null, null, now, null, null, "{}", 0);

    createDagSubsystem(makeDeps(ctx));

    const events = listAudit(db);
    const reconcileEvt = events.find(
      (e) => e.action === "dag.boot-reconcile" && e.target?.id === dagId,
    );
    assert.ok(reconcileEvt, "expected dag.boot-reconcile audit event");
    const detail = reconcileEvt?.detail as Record<string, unknown> | undefined;
    assert.equal(detail?.["nodeId"], nodeId);
    assert.equal(detail?.["from"], "running");
    assert.equal(detail?.["to"], "pending");
    assert.equal(detail?.["sessionSlug"], orphanSlug);
  });

  test("(c) loops: nextRunAt in the past is bumped to now", () => {
    const db = makeDb();
    const bus = new EventBus();
    const workspaceDir = makeWorkspace();
    const audit = makeAudit(db);

    const ctx = makeCtx({ db, bus, workspaceDir, audit });

    const loopId = newSlug("loop");
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const createdAt = oneHourAgo;

    db.prepare(`
      INSERT INTO loops (id, label, prompt, interval_sec, enabled, model_hint, repo_id, base_branch, jitter_pct, max_concurrent, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(loopId, "test loop", "do a thing", 60, 1, null, null, null, 0.1, 1, oneHourAgo, createdAt, createdAt);

    const result = createLoopsSubsystem(makeDeps(ctx));

    try {
      const row = db
        .prepare(`SELECT next_run_at FROM loops WHERE id = ?`)
        .get(loopId) as { next_run_at: string } | undefined;
      assert.ok(row?.next_run_at, "next_run_at should be set");
      const bumpedMs = Date.parse(row!.next_run_at);
      const drift = Math.abs(bumpedMs - now.getTime());
      assert.ok(drift < 5_000, `next_run_at should be bumped to ~now (drift=${drift}ms)`);

      const events = listAudit(db);
      const evt = events.find(
        (e) => e.action === "loop.boot-reconcile" && e.target?.id === loopId,
      );
      assert.ok(evt, "expected loop.boot-reconcile audit event");
    } finally {
      const onShutdown = result.onShutdown;
      if (onShutdown) Promise.resolve(onShutdown()).catch(() => {});
    }
  });

  test("(d) ship: ship_state row produces ship.boot-reconcile audit", () => {
    const db = makeDb();
    const bus = new EventBus();
    const workspaceDir = makeWorkspace();
    const audit = makeAudit(db);

    const slug = newSlug();
    insertSessionRow(db, {
      slug,
      mode: "ship",
      status: "running",
      worktreePath: path.join(workspaceDir, slug),
      shipStage: "dag",
    });

    db.prepare(`
      INSERT INTO ship_state(session_slug, stage, notes, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(slug, "dag", "[]", new Date().toISOString());

    const ctx = makeCtx({
      db,
      bus,
      workspaceDir,
      audit,
      sessionsGet: (s: string) =>
        s === slug
          ? {
              slug,
              title: "ship",
              prompt: "test",
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
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              childSlugs: [],
              metadata: {},
            }
          : null,
    });

    createShipSubsystem(makeDeps(ctx));

    const events = listAudit(db);
    const evt = events.find(
      (e) => e.action === "ship.boot-reconcile" && e.target?.id === slug,
    );
    assert.ok(evt, "expected ship.boot-reconcile audit event for slug");
    const detail = evt?.detail as Record<string, unknown> | undefined;
    assert.equal(detail?.["stage"], "dag");
    assert.equal(detail?.["status"], "running");
  });
});
