import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { EngineContext } from "../context.js";
import type { EventBus } from "../bus/eventBus.js";
import type { DagRepo } from "../dag/model.js";
import { applyLiveBase } from "./baseResolver.js";
import { migrations } from "../store/migrations.js";
import { SessionRepo } from "../store/repos/sessionRepo.js";
import { createLogger } from "../logger.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

function insertSessionRow(db: Database.Database, slug: string, worktreePath: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sessions(
      slug, title, prompt, mode, status, base_branch, worktree_path,
      attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens,
      stats_cache_read_tokens, stats_cache_creation_tokens,
      stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, created_at, updated_at, pr_draft, metadata
    ) VALUES (?, ?, ?, 'task', 'running', 'feature-gone', ?, '[]', '[]', 0, 0, 0, 0, 0, 0, 0, 0, 'mock', ?, ?, 0, '{}')
  `).run(slug, "test title", "test prompt", worktreePath, now, now);
}

const noopDagRepo: DagRepo = {
  list: () => [],
  getNodeBySession: () => null,
  byNodeSession: () => null,
  getNode: () => null,
  updateNode: () => { throw new Error("noop"); },
} as unknown as DagRepo;

describe("rebase_conflict attention persists across restart (baseResolver)", () => {
  test("applyLiveBase rebaseOnto failure writes attention to SQLite and survives a new SessionRepo", async () => {
    const db = makeDb();
    const slug = "base-resolver-persist";

    insertSessionRow(db, slug, "/tmp/fake-worktree");

    const sessionRepo = new SessionRepo(db);
    let currentSession = sessionRepo.get(slug)!;

    const ctx: EngineContext = {
      sessions: {
        get: (s: string) => s === slug ? currentSession : null,
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
        appendAttention: (s: string, flag: import("@minions/shared").AttentionFlag) => {
          const current = sessionRepo.get(s);
          if (!current) return;
          sessionRepo.setAttention(s, [...current.attention, flag]);
          currentSession = sessionRepo.get(s)!;
        },
        dismissAttention: () => { throw new Error("not implemented"); },
        kickReplyQueue: async () => false,
        resumeAllActive: async () => {},
        diff: async (s: string) => ({ sessionSlug: s, patch: "", stats: [], truncated: false, byteSize: 0, generatedAt: new Date().toISOString() }),
        screenshots: async () => [],
        screenshotPath: () => "",
        checkpoints: () => [],
        restoreCheckpoint: async () => {},
        updateBucket: () => {},
      },
      bus: { emit: () => {}, subscribe: () => () => {} } as unknown as EventBus,
      audit: { record: () => {}, list: () => [] },
      lifecycle: {} as EngineContext["lifecycle"],
      mutex: {} as EngineContext["mutex"],
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
    } as unknown as EngineContext;

    const branchExists = async () => false;
    const rebaseOnto = async () => { throw new Error("rebase conflict: simulated base conflict"); };

    await assert.rejects(
      () => applyLiveBase(slug, {
        ctx,
        dagRepo: noopDagRepo,
        log: createLogger("error"),
        sessionRepo: null,
        branchExists,
        rebaseOnto,
      }),
      /rebase conflict/,
    );

    const freshRepo = new SessionRepo(db);
    const persisted = freshRepo.get(slug);
    assert.ok(persisted, "session must exist after restart");
    const flag = persisted!.attention.find((a) => a.kind === "rebase_conflict");
    assert.ok(flag, "rebase_conflict attention flag must be persisted in SQLite");
    assert.match(flag!.message, /Re-base after live-base re-resolution failed/);

    db.close();
  });

  test("applyLiveBase walks past a non-conflict rebase failure and lands on a working ancestor", async () => {
    const db = makeDb();
    const slug = "fallback-walk";
    insertSessionRow(db, slug, "/tmp/fake-worktree");
    const sessionRepo = new SessionRepo(db);
    let currentSession = sessionRepo.get(slug)!;

    // Two ancestors and main exist on origin; only one rebase target works.
    const branchOnOrigin = new Set(["minions/ancestor-a", "minions/ancestor-b", "main"]);
    const rebaseAttempts: string[] = [];

    const ctx: EngineContext = {
      sessions: {
        get: (s: string) => (s === slug ? currentSession : null),
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
        appendAttention: (s: string, flag: import("@minions/shared").AttentionFlag) => {
          const current = sessionRepo.get(s);
          if (!current) return;
          sessionRepo.setAttention(s, [...current.attention, flag]);
          currentSession = sessionRepo.get(s)!;
        },
        dismissAttention: () => { throw new Error("not implemented"); },
        kickReplyQueue: async () => false,
        resumeAllActive: async () => {},
        diff: async (s: string) => ({ sessionSlug: s, patch: "", stats: [], truncated: false, byteSize: 0, generatedAt: new Date().toISOString() }),
        screenshots: async () => [],
        screenshotPath: () => "",
        checkpoints: () => [],
        restoreCheckpoint: async () => {},
        updateBucket: () => {},
      },
      bus: { emit: () => {}, subscribe: () => () => {} } as unknown as EventBus,
      audit: { record: () => {}, list: () => [] },
      lifecycle: {} as EngineContext["lifecycle"],
      mutex: {} as EngineContext["mutex"],
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
    } as unknown as EngineContext;

    // Mock dagRepo: session has 2 deps. Resolver picks ancestor-a first (which
    // exists on origin per branchExists), but its rebase will fail with
    // "fatal: invalid upstream" — the live failure pattern. Fallback should
    // try ancestor-b next, succeed there.
    const dagRepo = {
      list: () => [],
      getNodeBySession: () => ({
        id: "n-target",
        title: "target",
        prompt: "p",
        status: "running",
        dependsOn: ["n-a", "n-b"],
        sessionSlug: slug,
        branch: "minions/target",
      }),
      byNodeSession: () => ({
        id: "dag-1",
        title: "t",
        goal: "g",
        nodes: [],
        baseBranch: "main",
        rootSessionSlug: null,
        status: "active",
        repoId: "playground",
        metadata: {},
        createdAt: "",
        updatedAt: "",
      }),
      getNode: (id: string) => {
        if (id === "n-a") return { id, title: "a", prompt: "p", status: "pr-open", dependsOn: [], sessionSlug: "sess-a", branch: "minions/ancestor-a" };
        if (id === "n-b") return { id, title: "b", prompt: "p", status: "pr-open", dependsOn: [], sessionSlug: "sess-b", branch: "minions/ancestor-b" };
        return null;
      },
      updateNode: () => {},
    } as unknown as DagRepo;

    const branchExists = async ({ branch }: { worktreePath: string; branch: string }) => branchOnOrigin.has(branch);
    const rebaseOnto = async ({ branch }: { worktreePath: string; branch: string }) => {
      rebaseAttempts.push(branch);
      if (branch === "minions/ancestor-a") {
        throw new Error("fatal: invalid upstream 'origin/minions/ancestor-a'");
      }
      // ancestor-b succeeds
    };

    const result = await applyLiveBase(slug, {
      ctx,
      dagRepo,
      log: createLogger("error"),
      sessionRepo,
      branchExists,
      rebaseOnto,
    });

    assert.deepEqual(rebaseAttempts, ["minions/ancestor-a", "minions/ancestor-b"]);
    assert.equal(result.newBase, "minions/ancestor-b");
    assert.equal(result.changed, true);
    assert.equal(result.reason, "ancestor-fallback");

    db.close();
  });
});
