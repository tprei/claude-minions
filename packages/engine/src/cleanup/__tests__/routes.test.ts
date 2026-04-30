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
    assert.equal(body.truncated, false);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0]!.slug, h.completedSlug);
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
});
