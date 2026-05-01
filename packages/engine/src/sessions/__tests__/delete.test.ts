import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { simpleGit } from "simple-git";
import type { SessionDeletedEvent } from "@minions/shared";
import { EventBus } from "../../bus/eventBus.js";
import { SessionRegistry } from "../registry.js";
import { createLogger } from "../../logger.js";
import { migrations } from "../../store/migrations.js";
import type { EngineContext } from "../../context.js";
import type { ProviderHandle, ProviderEvent } from "../../providers/provider.js";
import { addWorktree } from "../../workspace/worktree.js";

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
  status = "running",
  opts: { repoId?: string | null; worktreePath?: string | null } = {},
): void {
  db.prepare(`
    INSERT INTO sessions(
      slug, title, prompt, mode, status, repo_id, worktree_path, attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens,
      stats_cache_read_tokens, stats_cache_creation_tokens,
      stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, created_at, updated_at, pr_draft, metadata
    ) VALUES (
      ?, ?, ?, 'task', ?, ?, ?, '[]', '[]',
      0, 0, 0, 0, 0, 0, 0, 0, 'mock', datetime('now'), datetime('now'), 0, '{}'
    )
  `).run(slug, "test", "prompt", status, opts.repoId ?? null, opts.worktreePath ?? null);
}

function insertTranscriptEvent(db: Database.Database, slug: string, seq: number): void {
  db.prepare(
    `INSERT INTO transcript_events(id, session_slug, seq, turn, kind, body, timestamp)
     VALUES (?, ?, ?, 0, 'user_message', ?, datetime('now'))`,
  ).run(`ev-${slug}-${seq}`, slug, seq, JSON.stringify({ text: "hi", source: "operator" }));
}

function insertReplyQueueRow(db: Database.Database, slug: string, payload: string): void {
  db.prepare(
    `INSERT INTO reply_queue(id, session_slug, payload, queued_at)
     VALUES (?, ?, ?, datetime('now'))`,
  ).run(`rq-${slug}-${payload}`, slug, payload);
}

function insertScreenshot(db: Database.Database, slug: string, filename: string): void {
  db.prepare(
    `INSERT INTO screenshots(id, session_slug, filename, byte_size, captured_at)
     VALUES (?, ?, ?, 0, datetime('now'))`,
  ).run(`sc-${slug}-${filename}`, slug, filename);
}

function insertCheckpoint(db: Database.Database, slug: string, id: string): void {
  db.prepare(
    `INSERT INTO checkpoints(id, session_slug, reason, sha, branch, message, turn, created_at)
     VALUES (?, ?, 'manual', 'sha', 'br', 'msg', 0, datetime('now'))`,
  ).run(id, slug);
}

function insertProviderState(db: Database.Database, slug: string): void {
  db.prepare(
    `INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
     VALUES (?, 'mock', 'ext-id', 0, 0, '{}', datetime('now'))`,
  ).run(slug);
}

interface AuditCall {
  actor: string;
  action: string;
  target?: { kind: string; id: string };
  detail?: Record<string, unknown>;
}

function makeStubCtx(audit: AuditCall[] = []): EngineContext {
  return {
    audit: {
      record: (
        actor: string,
        action: string,
        target?: { kind: string; id: string },
        detail?: Record<string, unknown>,
      ) => {
        audit.push({ actor, action, target, detail });
      },
      list: () => [],
    },
    dags: {
      onSessionTerminal: async () => {},
    },
    ship: {
      onTurnCompleted: async () => {},
    },
    env: {
      host: "127.0.0.1",
      port: 8787,
      token: "test-token",
    },
    memory: {
      renderPreamble: () => "",
    },
  } as unknown as EngineContext;
}

async function makeBareWithWorktree(
  workspaceDir: string,
  repoId: string,
  slug: string,
): Promise<string> {
  const reposDir = path.join(workspaceDir, ".repos");
  await fsp.mkdir(reposDir, { recursive: true });

  const seedDir = path.join(workspaceDir, "_seed");
  await fsp.mkdir(seedDir, { recursive: true });
  const seed = simpleGit(seedDir);
  await seed.init(["--initial-branch=main"]);
  await seed.addConfig("user.email", "test@local");
  await seed.addConfig("user.name", "Test");
  await fsp.writeFile(path.join(seedDir, "README.md"), "seed\n");
  await seed.add(".");
  await seed.commit("initial");

  const barePath = path.join(reposDir, `${repoId}.git`);
  await simpleGit().clone(seedDir, barePath, ["--bare"]);
  try {
    await simpleGit(barePath).raw(["remote", "add", "origin", seedDir]);
  } catch {
    /* no-op */
  }

  await addWorktree(reposDir, workspaceDir, repoId, slug, "main", createLogger("error"));
  return path.join(workspaceDir, slug);
}

function injectHandle(registry: SessionRegistry, slug: string, handle: ProviderHandle): void {
  (registry as unknown as { handles: Map<string, ProviderHandle> }).handles.set(slug, handle);
}

describe("SessionRegistry.delete", () => {
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let workspaceDir: string;
  let auditCalls: AuditCall[];

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "delete-test-"));
    auditCalls = [];
    registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx(auditCalls),
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("removes the session row and all related rows for the slug", async () => {
    const slug = "sess-target";
    const other = "sess-other";

    insertSession(db, slug);
    insertSession(db, other);

    insertTranscriptEvent(db, slug, 0);
    insertTranscriptEvent(db, slug, 1);
    insertTranscriptEvent(db, other, 0);

    insertReplyQueueRow(db, slug, "first");
    insertReplyQueueRow(db, slug, "second");
    insertReplyQueueRow(db, other, "kept");

    insertScreenshot(db, slug, "a.png");
    insertScreenshot(db, other, "b.png");

    insertCheckpoint(db, slug, "ck-target");
    insertCheckpoint(db, other, "ck-other");

    insertProviderState(db, slug);
    insertProviderState(db, other);

    await registry.delete(slug);

    const sessionRow = db.prepare(`SELECT slug FROM sessions WHERE slug = ?`).get(slug);
    assert.equal(sessionRow, undefined, "session row must be deleted");

    const transcriptCount = (db
      .prepare(`SELECT COUNT(*) AS c FROM transcript_events WHERE session_slug = ?`)
      .get(slug) as { c: number }).c;
    assert.equal(transcriptCount, 0, "transcript_events for slug must be deleted");

    const replyCount = (db
      .prepare(`SELECT COUNT(*) AS c FROM reply_queue WHERE session_slug = ?`)
      .get(slug) as { c: number }).c;
    assert.equal(replyCount, 0, "reply_queue rows for slug must be deleted");

    const screenshotCount = (db
      .prepare(`SELECT COUNT(*) AS c FROM screenshots WHERE session_slug = ?`)
      .get(slug) as { c: number }).c;
    assert.equal(screenshotCount, 0, "screenshots for slug must be deleted");

    const checkpointCount = (db
      .prepare(`SELECT COUNT(*) AS c FROM checkpoints WHERE session_slug = ?`)
      .get(slug) as { c: number }).c;
    assert.equal(checkpointCount, 0, "checkpoints for slug must be deleted");

    const providerStateCount = (db
      .prepare(`SELECT COUNT(*) AS c FROM provider_state WHERE session_slug = ?`)
      .get(slug) as { c: number }).c;
    assert.equal(providerStateCount, 0, "provider_state for slug must be deleted");

    const otherSession = db.prepare(`SELECT slug FROM sessions WHERE slug = ?`).get(other);
    assert.ok(otherSession, "unrelated session row must remain");
    const otherTranscript = (db
      .prepare(`SELECT COUNT(*) AS c FROM transcript_events WHERE session_slug = ?`)
      .get(other) as { c: number }).c;
    assert.equal(otherTranscript, 1, "unrelated transcript rows must remain");
    const otherReply = (db
      .prepare(`SELECT COUNT(*) AS c FROM reply_queue WHERE session_slug = ?`)
      .get(other) as { c: number }).c;
    assert.equal(otherReply, 1, "unrelated reply_queue rows must remain");
    const otherScreenshot = (db
      .prepare(`SELECT COUNT(*) AS c FROM screenshots WHERE session_slug = ?`)
      .get(other) as { c: number }).c;
    assert.equal(otherScreenshot, 1, "unrelated screenshots must remain");
    const otherCheckpoint = (db
      .prepare(`SELECT COUNT(*) AS c FROM checkpoints WHERE session_slug = ?`)
      .get(other) as { c: number }).c;
    assert.equal(otherCheckpoint, 1, "unrelated checkpoints must remain");
    const otherProviderState = (db
      .prepare(`SELECT COUNT(*) AS c FROM provider_state WHERE session_slug = ?`)
      .get(other) as { c: number }).c;
    assert.equal(otherProviderState, 1, "unrelated provider_state must remain");
  });

  test("emits session_deleted event with the deleted slug", async () => {
    const slug = "sess-emit";
    insertSession(db, slug);

    const events: SessionDeletedEvent[] = [];
    bus.on("session_deleted", (ev) => events.push(ev));

    await registry.delete(slug);

    assert.equal(events.length, 1, "exactly one session_deleted event");
    assert.equal(events[0]?.kind, "session_deleted");
    assert.equal(events[0]?.slug, slug);
  });

  test("kills the running provider handle before deleting", async () => {
    const slug = "sess-running";
    insertSession(db, slug, "running");

    const killSignals: NodeJS.Signals[] = [];
    const handle: ProviderHandle = {
      pid: 1234,
      kill(signal: NodeJS.Signals) {
        killSignals.push(signal);
      },
      write() {},
      waitForExit() {
        return new Promise(() => {});
      },
      async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {},
    };
    injectHandle(registry, slug, handle);

    await registry.delete(slug);

    assert.equal(killSignals.length, 1, "handle.kill must be called once");
    assert.equal(
      (registry as unknown as { handles: Map<string, ProviderHandle> }).handles.has(slug),
      false,
      "handle map entry must be removed",
    );
  });

  test("throws not_found for a missing slug", async () => {
    await assert.rejects(() => registry.delete("does-not-exist"), /not found/i);
  });

  test("removes the worktree directory when worktree_path + repo_id are set", async () => {
    const slug = "sess-wt";
    const repoId = "repo-wt";
    const worktreePath = await makeBareWithWorktree(workspaceDir, repoId, slug);
    insertSession(db, slug, "running", { repoId, worktreePath });

    assert.ok(fs.existsSync(worktreePath), "worktree exists before delete");

    await registry.delete(slug);

    assert.equal(fs.existsSync(worktreePath), false, "worktree should be removed");
  });

  test("removes uploads, reply-queue, and mcp-configs side-effect paths", async () => {
    const slug = "sess-side";
    const uploadsDir = path.join(workspaceDir, "uploads", slug);
    const replyQueueFile = path.join(workspaceDir, "reply-queue", `${slug}.jsonl`);
    const mcpConfigFile = path.join(workspaceDir, "mcp-configs", `${slug}.json`);

    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, "a.txt"), "x");
    fs.mkdirSync(path.dirname(replyQueueFile), { recursive: true });
    fs.writeFileSync(replyQueueFile, "{}\n");
    fs.mkdirSync(path.dirname(mcpConfigFile), { recursive: true });
    fs.writeFileSync(mcpConfigFile, "{}");

    insertSession(db, slug);

    await registry.delete(slug);

    assert.equal(fs.existsSync(uploadsDir), false, "uploads dir should be removed");
    assert.equal(fs.existsSync(replyQueueFile), false, "reply-queue jsonl should be removed");
    assert.equal(fs.existsSync(mcpConfigFile), false, "mcp-configs json should be removed");
  });

  test("tolerates missing side-effect paths (ENOENT) without throwing", async () => {
    const slug = "sess-enoent";
    insertSession(db, slug);

    // No side-effect files created — every path is ENOENT.
    await assert.doesNotReject(() => registry.delete(slug));

    const row = db.prepare(`SELECT slug FROM sessions WHERE slug = ?`).get(slug);
    assert.equal(row, undefined, "session row removed even when side-effect paths are missing");
  });

  test("still removes DB row and emits session_deleted when worktree removal fails", async () => {
    const slug = "sess-wt-fail";
    const repoId = "repo-broken";
    // Create a bare-path placeholder that is NOT a real git repo so removeWorktree's
    // `git worktree remove` and fallback `git worktree prune` both fail and the
    // function rejects. This exercises the catch in registry.delete.
    const bogusBare = path.join(workspaceDir, ".repos", `${repoId}.git`);
    fs.mkdirSync(bogusBare, { recursive: true });
    const worktreePath = path.join(workspaceDir, slug);
    fs.mkdirSync(worktreePath, { recursive: true });

    insertSession(db, slug, "running", { repoId, worktreePath });

    const events: SessionDeletedEvent[] = [];
    bus.on("session_deleted", (ev) => events.push(ev));

    await assert.doesNotReject(() => registry.delete(slug));

    const row = db.prepare(`SELECT slug FROM sessions WHERE slug = ?`).get(slug);
    assert.equal(row, undefined, "session row removed even when removeWorktree throws");
    assert.equal(events.length, 1, "session_deleted still emitted");
    assert.equal(events[0]?.slug, slug);
  });

  test("records an operator audit event with the expected shape", async () => {
    const slug = "sess-audit";
    insertSession(db, slug);

    await registry.delete(slug);

    const ours = auditCalls.filter((c) => c.action === "session.delete");
    assert.equal(ours.length, 1, "exactly one session.delete audit event");
    assert.equal(ours[0]?.actor, "operator");
    assert.deepEqual(ours[0]?.target, { kind: "session", id: slug });
    assert.deepEqual(ours[0]?.detail, {});
  });
});
