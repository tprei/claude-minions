import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { simpleGit } from "simple-git";
import type {
  SessionDeletedEvent,
  CleanupCandidatesResponse,
  CleanupExecuteResponse,
  CleanupPreviewResponse,
} from "@minions/shared";
import { EventBus } from "../../bus/eventBus.js";
import { SessionRegistry } from "../../sessions/registry.js";
import { createLogger } from "../../logger.js";
import { migrations } from "../../store/migrations.js";
import type { EngineContext } from "../../context.js";
import { isEngineError } from "../../errors.js";
import { makeCleanupSubsystem } from "../index.js";
import { registerCleanupRoutes } from "../routes.js";

interface AuditCall {
  actor: string;
  action: string;
  target?: { kind: string; id: string };
  detail?: Record<string, unknown>;
}

interface Harness {
  app: FastifyInstance;
  db: Database.Database;
  bus: EventBus;
  workspaceDir: string;
  reposDir: string;
  auditCalls: AuditCall[];
  deletedEvents: SessionDeletedEvent[];
  completedSlug: string;
  runningSlug: string;
  failedSlug: string;
  completedWorktreePath: string;
  cleanup: () => Promise<void>;
}

function insertSession(
  db: Database.Database,
  slug: string,
  status: string,
  completedAt: string | null,
  repoId: string | null,
  worktreePath: string | null,
  branch: string | null,
): void {
  db.prepare(
    `INSERT INTO sessions(
      slug, title, prompt, mode, status, repo_id, branch, worktree_path,
      attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens,
      stats_cache_read_tokens, stats_cache_creation_tokens,
      stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, created_at, updated_at, completed_at, pr_draft, metadata
    ) VALUES (
      ?, ?, 'p', 'task', ?, ?, ?, ?,
      '[]', '[]',
      0, 0, 0, 0, 0, 0, 0, 0,
      'mock', datetime('now'), datetime('now'), ?, 0, '{}'
    )`,
  ).run(slug, slug, status, repoId, branch, worktreePath, completedAt);
}

async function buildHarness(): Promise<Harness> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-routes-test-"));

  const seedDir = path.join(workspaceDir, "_seed");
  await fs.mkdir(seedDir, { recursive: true });
  const seed = simpleGit(seedDir);
  await seed.init(["--initial-branch=main"]);
  await seed.addConfig("user.email", "test@local");
  await seed.addConfig("user.name", "Test");
  await fs.writeFile(path.join(seedDir, "README.md"), "seed\n");
  await seed.add(".");
  await seed.commit("initial");

  const repoId = "repo-fixture";
  const reposDir = path.join(workspaceDir, ".repos");
  await fs.mkdir(reposDir, { recursive: true });
  const barePath = path.join(reposDir, `${repoId}.git`);
  await simpleGit().clone(seedDir, barePath, ["--bare"]);
  try {
    await simpleGit(barePath).raw(["remote", "add", "origin", seedDir]);
  } catch {
    /* ignore */
  }

  const completedSlug = "completed-slug";
  const runningSlug = "running-slug";
  const failedSlug = "failed-slug";
  const completedWorktreePath = path.join(workspaceDir, completedSlug);

  const bareGit = simpleGit(barePath);
  await bareGit.raw([
    "worktree",
    "add",
    "-b",
    `minions/${completedSlug}`,
    completedWorktreePath,
    "main",
  ]);
  await fs.writeFile(path.join(completedWorktreePath, "data.txt"), Buffer.alloc(2048));

  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);

  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const oneDayAgo = new Date(Date.now() - 1 * 86_400_000).toISOString();

  insertSession(db, runningSlug, "running", null, null, null, null);
  insertSession(
    db,
    completedSlug,
    "completed",
    tenDaysAgo,
    repoId,
    completedWorktreePath,
    `minions/${completedSlug}`,
  );
  insertSession(db, failedSlug, "failed", oneDayAgo, null, null, null);

  const bus = new EventBus();
  const log = createLogger("error");

  const stubCtx = {
    audit: { record: () => {}, list: () => [] },
    dags: { onSessionTerminal: async () => {} },
    ship: { onTurnCompleted: async () => {} },
    env: { host: "127.0.0.1", port: 0, token: "x" },
    memory: { renderPreamble: () => "" },
  } as unknown as EngineContext;

  const registry = new SessionRegistry({ db, bus, log, workspaceDir, ctx: stubCtx });

  const sessionsApi = {
    get: (slug: string) => registry.get(slug),
    listPaged: (opts: Parameters<typeof registry.listPaged>[0]) => registry.listPaged(opts),
    delete: (slug: string) => registry.delete(slug),
  } as unknown as EngineContext["sessions"];

  const auditCalls: AuditCall[] = [];
  const auditApi: EngineContext["audit"] = {
    record: (actor, action, target, detail) => {
      auditCalls.push({ actor, action, target, detail });
    },
    list: () => [],
  };

  const cleanup = makeCleanupSubsystem({
    sessions: sessionsApi,
    audit: auditApi,
    workspaceDir,
    reposDir,
    worktreeRoot: workspaceDir,
    log,
    bus,
  });

  const ctx = {
    sessions: sessionsApi,
    audit: auditApi,
    cleanup,
    log,
    bus,
    workspaceDir,
  } as unknown as EngineContext;

  const app = Fastify({ logger: false });
  app.setErrorHandler(async (err, _req, reply) => {
    if (isEngineError(err)) {
      await reply.status(err.status).send(err.toJSON());
      return;
    }
    await reply.status(500).send({ error: "internal", message: (err as Error).message });
  });
  registerCleanupRoutes(app, ctx);

  const deletedEvents: SessionDeletedEvent[] = [];
  bus.on("session_deleted", (ev) => deletedEvents.push(ev));

  return {
    app,
    db,
    bus,
    workspaceDir,
    reposDir,
    auditCalls,
    deletedEvents,
    completedSlug,
    runningSlug,
    failedSlug,
    completedWorktreePath,
    cleanup: async () => {
      await app.close();
      db.close();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    },
  };
}

describe("cleanup routes", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  test("GET /api/cleanup/candidates returns only sessions older than the threshold", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/cleanup/candidates?olderThanDays=7",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CleanupCandidatesResponse;
    assert.equal(body.nextCursor, null);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0]!.slug, h.completedSlug);
    assert.equal(
      "worktreeBytes" in (body.items[0] as unknown as Record<string, unknown>),
      false,
      "list endpoint must not return worktree byte sizes",
    );
  });

  test("GET /api/cleanup/candidates rejects limit > 500", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/cleanup/candidates?olderThanDays=0&limit=501",
    });
    assert.equal(res.statusCode, 400);
  });

  test("GET /api/cleanup/candidates paginates 500 sessions in 100-row pages", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    for (let i = 0; i < 500; i++) {
      insertSession(h.db, `bulk-${i.toString().padStart(4, "0")}`, "completed", tenDaysAgo, null, null, null);
    }

    const t0 = Date.now();
    const first = await h.app.inject({
      method: "GET",
      url: "/api/cleanup/candidates?olderThanDays=0&limit=100",
    });
    const elapsed = Date.now() - t0;
    assert.equal(first.statusCode, 200);
    const firstBody = first.json() as CleanupCandidatesResponse;
    assert.equal(firstBody.items.length, 100, "first page must hold 100 rows");
    assert.ok(firstBody.nextCursor, "first page must yield a cursor for next page");
    assert.ok(elapsed < 2000, `first page should return quickly without du, took ${elapsed}ms`);

    const seen = new Set(firstBody.items.map((c) => c.slug));
    async function fetchPage(c: string): Promise<CleanupCandidatesResponse> {
      const r = await h.app.inject({
        method: "GET",
        url: `/api/cleanup/candidates?olderThanDays=0&limit=100&cursor=${encodeURIComponent(c)}`,
      });
      assert.equal(r.statusCode, 200);
      return r.json() as CleanupCandidatesResponse;
    }

    let cursor: string | null = firstBody.nextCursor;
    let pages = 1;
    while (cursor !== null) {
      const body = await fetchPage(cursor);
      for (const item of body.items) {
        assert.equal(seen.has(item.slug), false, `duplicate slug ${item.slug} across pages`);
        seen.add(item.slug);
      }
      cursor = body.nextCursor;
      pages++;
      if (pages > 20) throw new Error("pagination did not terminate");
    }

    assert.ok(seen.size >= 500, `expected at least 500 unique slugs, got ${seen.size}`);
  });

  test("POST /api/cleanup/preview computes selection size within budget", async () => {
    const t0 = Date.now();
    const res = await h.app.inject({
      method: "POST",
      url: "/api/cleanup/preview",
      payload: { slugs: [h.completedSlug], removeWorktree: true },
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200);
    const body = res.json() as CleanupPreviewResponse;
    assert.ok(body.totalBytes > 0, `expected totalBytes > 0, got ${body.totalBytes}`);
    assert.ok(elapsed < 30_000, `preview must complete within 30s, took ${elapsed}ms`);
  });

  test("POST /api/cleanup/preview marks the running session as ineligible", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/cleanup/preview",
      payload: { slugs: [h.runningSlug, h.completedSlug], removeWorktree: true },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CleanupPreviewResponse;
    assert.equal(body.count, 1);
    assert.ok(body.totalBytes > 0, `expected totalBytes > 0, got ${body.totalBytes}`);
    assert.equal(body.ineligible.length, 1);
    assert.equal(body.ineligible[0]!.slug, h.runningSlug);
  });

  test("POST /api/cleanup/execute removes worktree, records audit, emits session_deleted", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/cleanup/execute",
      payload: { slugs: [h.completedSlug], removeWorktree: true },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CleanupExecuteResponse;
    assert.equal(body.deleted, 1);
    assert.ok(body.bytesReclaimed > 0, `expected bytesReclaimed > 0, got ${body.bytesReclaimed}`);
    assert.deepEqual(body.errors, []);

    const cleanupAudit = h.auditCalls.find((a) => a.action === "session.cleanup");
    assert.ok(cleanupAudit, "cleanup audit must be recorded");
    assert.equal(cleanupAudit!.target?.id, h.completedSlug);

    assert.equal(h.deletedEvents.length, 1);
    assert.equal(h.deletedEvents[0]!.slug, h.completedSlug);

    let exists = true;
    try {
      await fs.access(h.completedWorktreePath);
    } catch {
      exists = false;
    }
    assert.equal(exists, false, "worktree dir must be removed from FS");
  });

  test("POST /api/cleanup/execute on a running session is rejected without DB mutation", async () => {
    const beforeCount = (h.db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number })
      .c;

    const res = await h.app.inject({
      method: "POST",
      url: "/api/cleanup/execute",
      payload: { slugs: [h.runningSlug], removeWorktree: true },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CleanupExecuteResponse;
    assert.equal(body.deleted, 0);
    assert.equal(body.errors.length, 1);
    assert.equal(body.errors[0]!.code, "ineligible_status");

    const afterCount = (h.db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number })
      .c;
    assert.equal(afterCount, beforeCount);
  });

  test("POST /api/cleanup/execute deletes 50 sessions in parallel with concurrency cap of 8", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const slugs: string[] = [];
    for (let i = 0; i < 50; i++) {
      const slug = `bulk-exec-${i.toString().padStart(2, "0")}`;
      slugs.push(slug);
      insertSession(h.db, slug, "completed", tenDaysAgo, null, null, null);
    }

    const beforeCount = (h.db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number })
      .c;

    const res = await h.app.inject({
      method: "POST",
      url: "/api/cleanup/execute",
      payload: { slugs, removeWorktree: false },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CleanupExecuteResponse;
    assert.equal(body.deleted, 50);
    assert.deepEqual(body.errors, []);

    const afterCount = (h.db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number })
      .c;
    assert.equal(afterCount, beforeCount - 50);
  });

  test("execute() bounds in-flight session deletes at concurrency cap of 8", async () => {
    const N = 50;
    const slugs = Array.from({ length: N }, (_, i) => `cap-${i}`);

    let inFlight = 0;
    let maxInFlight = 0;
    const completed: string[] = [];

    const stubSessions = {
      get: (slug: string) =>
        ({
          slug,
          title: slug,
          status: "completed",
          worktreePath: null,
          repoId: null,
          branch: null,
        }) as unknown as ReturnType<SessionRegistry["get"]>,
      listPaged: () => ({ items: [], nextCursor: undefined }),
      delete: async (slug: string) => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 15));
        inFlight--;
        completed.push(slug);
      },
    } as unknown as EngineContext["sessions"];

    const stubAudit: EngineContext["audit"] = { record: () => {}, list: () => [] };
    const stubLog = createLogger("error");
    const stubBus = new EventBus();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-cap-test-"));

    const subsystem = makeCleanupSubsystem({
      sessions: stubSessions,
      audit: stubAudit,
      workspaceDir: tmpDir,
      reposDir: tmpDir,
      worktreeRoot: tmpDir,
      log: stubLog,
      bus: stubBus,
    });

    const result = await subsystem.execute({ slugs, removeWorktree: false });

    assert.equal(result.deleted, N);
    assert.deepEqual(result.errors, []);
    assert.equal(completed.length, N);
    assert.ok(maxInFlight <= 8, `maxInFlight ${maxInFlight} must not exceed 8`);
    assert.ok(maxInFlight >= 2, `maxInFlight ${maxInFlight} should show parallelism`);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
