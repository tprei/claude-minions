import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { AuditEvent, Session } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { EventBus } from "../bus/eventBus.js";
import type { DagRepo } from "../dag/model.js";
import { RestackManager } from "./restack.js";
import { KeyedMutex } from "../util/mutex.js";
import { createLogger } from "../logger.js";
import { migrations } from "../store/migrations.js";
import { SessionRepo } from "../store/repos/sessionRepo.js";

interface RestackHarness {
  ctx: EngineContext;
  audit: AuditEvent[];
  retryCalls: string[];
  retryDelays: Map<string, number>;
  events: Array<{ kind: string; [k: string]: unknown }>;
  mutex: KeyedMutex;
}

function buildSession(slug: string, overrides: Partial<Session> = {}): Session {
  return {
    slug,
    title: slug,
    prompt: "do work",
    mode: "task",
    status: "running",
    attention: [],
    quickActions: [],
    branch: `minions/${slug}`,
    baseBranch: "main",
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

function makeHarness(sessions: Session[]): RestackHarness {
  const audit: AuditEvent[] = [];
  const retryCalls: string[] = [];
  const retryDelays = new Map<string, number>();
  const events: Array<{ kind: string; [k: string]: unknown }> = [];
  const mutex = new KeyedMutex();
  const sessionMap = new Map(sessions.map((s) => [s.slug, s]));

  const ctx: EngineContext = {
    sessions: {
      create: async () => {
        throw new Error("not implemented");
      },
      get: (slug) => sessionMap.get(slug) ?? null,
      list: () => Array.from(sessionMap.values()),
      listPaged: () => ({ items: [] }),
      listWithTranscript: () => [],
      transcript: () => [],
      stop: async () => {},
      close: async () => {},
      delete: async () => {},
      reply: async () => {},
      setDagId: () => {},
      setMetadata: () => {},
      markCompleted: () => {},
      markFailed: () => {},
      spawnPending: async () => ({ spawned: false }),
      markWaitingInput: () => {},
      appendAttention: () => {},
      dismissAttention: () => { throw new Error("not implemented"); },
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
    landing: {
      land: async () => {},
      openForReview: async () => null,
      retryRebase: async (slug: string) => {
        retryCalls.push(slug);
        const delay = retryDelays.get(slug);
        if (delay !== undefined && delay > 0) {
          await new Promise((r) => setTimeout(r, delay));
        }
      },
      onUpstreamMerged: async () => {},
      editPRBase: async () => {},
    },
    bus: {
      emit: (ev: { kind: string; [k: string]: unknown }) => {
        events.push(ev);
      },
      subscribe: () => () => {},
    } as unknown as EventBus,
    audit: {
      record: (actor, action, target, detail) => {
        audit.push({
          id: String(audit.length + 1),
          timestamp: new Date().toISOString(),
          actor,
          action,
          target,
          detail,
        });
      },
      list: () => audit.slice(),
    },
    lifecycle: {} as EngineContext["lifecycle"],
    mutex,
    runtime: {
      schema: () => ({ groups: [], fields: [] }),
      values: () => ({}),
      effective: () => ({}),
      update: async () => {},
    },
    dags: {} as EngineContext["dags"],
    ship: {} as EngineContext["ship"],
    loops: {} as EngineContext["loops"],
    variants: {} as EngineContext["variants"],
    ci: {} as EngineContext["ci"],
    quality: {} as EngineContext["quality"],
    readiness: {} as EngineContext["readiness"],
    intake: {} as EngineContext["intake"],
    memory: {} as EngineContext["memory"],
    resource: {} as EngineContext["resource"],
    push: {} as EngineContext["push"],
    digest: {} as EngineContext["digest"],
    github: {} as EngineContext["github"],
    stats: {} as EngineContext["stats"],
    cleanup: {} as EngineContext["cleanup"],
    env: {} as EngineContext["env"],
    log: createLogger("error"),
    db: {} as EngineContext["db"],
    workspaceDir: "/tmp",
    previousMarker: null,
    features: () => [],
    featuresPending: () => [],
    repos: () => [],
    getRepo: () => null,
    shutdown: async () => {},
  };

  return { ctx, audit, retryCalls, retryDelays, events, mutex };
}

const noopDagRepo: DagRepo = {
  list: () => [],
  getNodeBySession: () => null,
  byNodeSession: () => null,
  getNode: () => null,
  updateNode: () => {
    throw new Error("noop dag repo: updateNode not implemented");
  },
} as unknown as DagRepo;

const alwaysExistsBranch = async () => true;
const noopRebase = async () => {};

describe("RestackManager", () => {
  test("rebase waits for in-flight session turn holding the slug mutex", async () => {
    const parent = buildSession("parent", { branch: "main" });
    const child = buildSession("child", { baseBranch: "main", branch: "minions/child" });

    const h = makeHarness([parent, child]);
    const restack = new RestackManager(h.ctx, noopDagRepo, createLogger("error"), {
      branchExistsOnRemote: alwaysExistsBranch,
      rebaseOnto: noopRebase,
    });

    // Simulate a long-running provider turn holding the child's slug mutex.
    let turnCompleted = false;
    let rebaseStartedDuringTurn = false;
    const turnReleased = h.mutex.run("child", async () => {
      // 50ms simulates provider running git operations inside the worktree.
      await new Promise((r) => setTimeout(r, 50));
      turnCompleted = true;
    });

    // Yield so the turn promise actually starts and grabs the mutex.
    await Promise.resolve();
    assert.equal(h.mutex.isLocked("child"), true, "child mutex held by simulated turn");

    const restackPromise = restack.restackChildren("parent");

    // Give the restack a moment to attempt acquiring the mutex.
    await new Promise((r) => setTimeout(r, 10));
    rebaseStartedDuringTurn = h.retryCalls.length > 0;
    assert.equal(rebaseStartedDuringTurn, false, "rebase must not start while turn holds mutex");
    assert.equal(turnCompleted, false, "turn still in flight");

    await turnReleased;
    await restackPromise;

    assert.equal(turnCompleted, true, "turn completed before rebase");
    assert.deepEqual(h.retryCalls, ["child"], "rebase ran exactly once after turn released");

    const acquireRecords = h.audit.filter((e) => e.action === "restack:session:mutex-acquire");
    const releaseRecords = h.audit.filter((e) => e.action === "restack:session:mutex-release");
    assert.equal(acquireRecords.length, 1, "audit captured one acquire");
    assert.equal(releaseRecords.length, 1, "audit captured one release");
    assert.equal(acquireRecords[0]?.target?.id, "child");
    assert.equal(releaseRecords[0]?.target?.id, "child");
    const acquireIdx = h.audit.findIndex((e) => e.action === "restack:session:mutex-acquire");
    const releaseIdx = h.audit.findIndex((e) => e.action === "restack:session:mutex-release");
    assert.ok(acquireIdx < releaseIdx, "acquire recorded before release");
  });

  test("audit log records acquire and release even when rebase fails", async () => {
    const parent = buildSession("parent", { branch: "main" });
    const child = buildSession("child", { baseBranch: "main" });

    const h = makeHarness([parent, child]);
    h.ctx.landing.retryRebase = async () => {
      throw new Error("rebase conflict: simulated");
    };
    h.ctx.sessions.create = async () => buildSession("resolver");

    const restack = new RestackManager(h.ctx, noopDagRepo, createLogger("error"), {
      branchExistsOnRemote: alwaysExistsBranch,
      rebaseOnto: noopRebase,
    });
    await restack.restackChildren("parent");

    const acquire = h.audit.filter((e) => e.action === "restack:session:mutex-acquire");
    const release = h.audit.filter((e) => e.action === "restack:session:mutex-release");
    assert.equal(acquire.length, 1, "acquire recorded");
    assert.equal(release.length, 1, "release recorded despite failure");
    assert.equal(h.mutex.isLocked("child"), false, "mutex released after failure");
  });
});

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

function insertSessionRow(db: Database.Database, slug: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sessions(
      slug, title, prompt, mode, status, attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens,
      stats_cache_read_tokens, stats_cache_creation_tokens,
      stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, created_at, updated_at, pr_draft, metadata
    ) VALUES (?, ?, ?, 'task', 'running', '[]', '[]', 0, 0, 0, 0, 0, 0, 0, 0, 'mock', ?, ?, 0, '{}')
  `).run(slug, "test title", "test prompt", now, now);
}

describe("rebase_conflict attention persists across restart", () => {
  test("restackChild conflict writes attention to SQLite and survives a new SessionRepo", async () => {
    const db = makeDb();
    const slug = "child-persist";

    insertSessionRow(db, slug);

    const sessionRepo = new SessionRepo(db);
    let currentSession = sessionRepo.get(slug)!;

    const mutex = new KeyedMutex();
    const ctx: EngineContext = {
      sessions: {
        get: (s) => s === slug ? currentSession : null,
        list: () => [currentSession],
        create: async () => buildSession("resolver"),
        listPaged: () => ({ items: [] }),
        listWithTranscript: () => [],
        transcript: () => [],
        stop: async () => {},
        close: async () => {},
        delete: async () => {},
        reply: async () => {},
        setDagId: () => {},
        setMetadata: () => {},
        markCompleted: () => {},
        markFailed: () => {},
        spawnPending: async () => ({ spawned: false }),
        markWaitingInput: () => {},
        appendAttention: (s, flag) => {
          const current = sessionRepo.get(s);
          if (!current) return;
          sessionRepo.setAttention(s, [...current.attention, flag]);
          currentSession = sessionRepo.get(s)!;
        },
        dismissAttention: () => { throw new Error("not implemented"); },
        kickReplyQueue: async () => false,
        resumeAllActive: async () => {},
        diff: async (s) => ({ sessionSlug: s, patch: "", stats: [], truncated: false, byteSize: 0, generatedAt: new Date().toISOString() }),
        screenshots: async () => [],
        screenshotPath: () => "",
        checkpoints: () => [],
        restoreCheckpoint: async () => {},
        updateBucket: () => {},
      },
      landing: {
        land: async () => {},
        openForReview: async () => null,
        retryRebase: async () => { throw new Error("rebase conflict: simulated"); },
        onUpstreamMerged: async () => {},
        editPRBase: async () => {},
      },
      bus: { emit: () => {}, subscribe: () => () => {} } as unknown as EventBus,
      audit: { record: () => {}, list: () => [] },
      lifecycle: {} as EngineContext["lifecycle"],
      mutex,
      runtime: { schema: () => ({ groups: [], fields: [] }), values: () => ({}), effective: () => ({}), update: async () => {} },
      dags: {} as EngineContext["dags"],
      ship: {} as EngineContext["ship"],
      loops: {} as EngineContext["loops"],
      variants: {} as EngineContext["variants"],
      ci: {} as EngineContext["ci"],
      quality: {} as EngineContext["quality"],
      readiness: {} as EngineContext["readiness"],
      intake: {} as EngineContext["intake"],
      memory: {} as EngineContext["memory"],
      resource: {} as EngineContext["resource"],
      push: {} as EngineContext["push"],
      digest: {} as EngineContext["digest"],
      github: {} as EngineContext["github"],
      stats: {} as EngineContext["stats"],
      cleanup: {} as EngineContext["cleanup"],
      env: {} as EngineContext["env"],
      log: createLogger("error"),
      db: {} as EngineContext["db"],
      workspaceDir: "/tmp",
      previousMarker: null,
      features: () => [],
      featuresPending: () => [],
      repos: () => [],
      getRepo: () => null,
      shutdown: async () => {},
    };

    const restack = new RestackManager(ctx, noopDagRepo, createLogger("error"), {
      branchExistsOnRemote: alwaysExistsBranch,
      rebaseOnto: noopRebase,
    });

    await restack.restackChild(slug, "main");

    const freshRepo = new SessionRepo(db);
    const persisted = freshRepo.get(slug);
    assert.ok(persisted, "session row must exist after restart");
    const flag = persisted!.attention.find((a) => a.kind === "rebase_conflict");
    assert.ok(flag, "rebase_conflict attention flag must be persisted in SQLite");
    assert.match(flag!.message, /Restack conflict after landing/);

    db.close();
  });

  test("restackDagNode conflict writes attention to SQLite and survives a new SessionRepo", async () => {
    const db = makeDb();
    const sessionSlug = "dag-child-persist";
    insertSessionRow(db, sessionSlug);

    const sessionRepo = new SessionRepo(db);

    const mutex = new KeyedMutex();

    let currentSession = sessionRepo.get(sessionSlug)!;

    const dagNode = { id: "node-1", title: "n1", prompt: "p", status: "running" as const, dependsOn: [], metadata: {} };
    const dagRepo: DagRepo = {
      list: () => [],
      getNodeBySession: () => null,
      byNodeSession: () => null,
      getNode: () => null,
      updateNode: (id: string, patch: Partial<import("@minions/shared").DAGNode>) => {
        currentSession = { ...currentSession, ...(patch.status ? { status: "running" } : {}) };
        return { ...dagNode, ...patch };
      },
    } as unknown as DagRepo;

    const ctx: EngineContext = {
      sessions: {
        get: (s) => s === sessionSlug ? currentSession : null,
        list: () => [currentSession],
        create: async () => { throw new Error("not implemented"); },
        listPaged: () => ({ items: [] }),
        listWithTranscript: () => [],
        transcript: () => [],
        stop: async () => {},
        close: async () => {},
        delete: async () => {},
        reply: async () => {},
        setDagId: () => {},
        setMetadata: () => {},
        markCompleted: () => {},
        markFailed: () => {},
        spawnPending: async () => ({ spawned: false }),
        markWaitingInput: () => {},
        appendAttention: (s, flag) => {
          const current = sessionRepo.get(s);
          if (!current) return;
          sessionRepo.setAttention(s, [...current.attention, flag]);
          currentSession = sessionRepo.get(s)!;
        },
        dismissAttention: () => { throw new Error("not implemented"); },
        kickReplyQueue: async () => false,
        resumeAllActive: async () => {},
        diff: async (s) => ({ sessionSlug: s, patch: "", stats: [], truncated: false, byteSize: 0, generatedAt: new Date().toISOString() }),
        screenshots: async () => [],
        screenshotPath: () => "",
        checkpoints: () => [],
        restoreCheckpoint: async () => {},
        updateBucket: () => {},
      },
      landing: {
        land: async () => {},
        openForReview: async () => null,
        retryRebase: async () => { throw new Error("rebase conflict: dag simulated"); },
        onUpstreamMerged: async () => {},
        editPRBase: async () => {},
      },
      bus: { emit: () => {}, subscribe: () => () => {} } as unknown as EventBus,
      audit: { record: () => {}, list: () => [] },
      lifecycle: {} as EngineContext["lifecycle"],
      mutex,
      runtime: { schema: () => ({ groups: [], fields: [] }), values: () => ({}), effective: () => ({}), update: async () => {} },
      dags: {} as EngineContext["dags"],
      ship: {} as EngineContext["ship"],
      loops: {} as EngineContext["loops"],
      variants: {} as EngineContext["variants"],
      ci: {} as EngineContext["ci"],
      quality: {} as EngineContext["quality"],
      readiness: {} as EngineContext["readiness"],
      intake: {} as EngineContext["intake"],
      memory: {} as EngineContext["memory"],
      resource: {} as EngineContext["resource"],
      push: {} as EngineContext["push"],
      digest: {} as EngineContext["digest"],
      github: {} as EngineContext["github"],
      stats: {} as EngineContext["stats"],
      cleanup: {} as EngineContext["cleanup"],
      env: {} as EngineContext["env"],
      log: createLogger("error"),
      db: {} as EngineContext["db"],
      workspaceDir: "/tmp",
      previousMarker: null,
      features: () => [],
      featuresPending: () => [],
      repos: () => [],
      getRepo: () => null,
      shutdown: async () => {},
    };

    const restack = new RestackManager(ctx, dagRepo, createLogger("error"), {
      branchExistsOnRemote: alwaysExistsBranch,
      rebaseOnto: noopRebase,
    });

    ctx.sessions.create = async () => buildSession("dag-resolver");
    await restack.restackDagChild("dag-1", "node-1", sessionSlug, "main");

    const freshRepo = new SessionRepo(db);
    const persisted = freshRepo.get(sessionSlug);
    assert.ok(persisted, "session row must exist after restart");
    const flag = persisted!.attention.find((a) => a.kind === "rebase_conflict");
    assert.ok(flag, "rebase_conflict attention flag must be persisted in SQLite (dag node path)");
    assert.match(flag!.message, /Restack conflict:/);

    db.close();
  });
});
