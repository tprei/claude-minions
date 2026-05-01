import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import type { Session, TranscriptEvent } from "@minions/shared";
import { openStore } from "../../store/sqlite.js";
import { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import {
  buildVerifierPrompt,
  createVerifyChildSpawnHandler,
  enqueueVerifyChild,
  parseVerifierVerdict,
  readVerifyChildAttempts,
  VERIFY_CHILD_MAX_RETRIES,
} from "./verifyChild.js";
import type { EngineContext } from "../../context.js";
import { createLogger } from "../../logger.js";

interface Env {
  db: Database.Database;
  repo: AutomationJobRepo;
  cleanup: () => void;
}

function setup(): Env {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-verify-child-"));
  const dbPath = path.join(tmpDir, "test.db");
  const log = createLogger("error");
  const db = openStore({ path: dbPath, log });
  const repo = new AutomationJobRepo(db);
  return {
    db,
    repo,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    slug: overrides.slug ?? "child-1",
    title: "child task",
    prompt: "implement feature X with acceptance criteria Y",
    mode: "dag-task",
    status: "completed",
    pr: {
      number: 999,
      url: "https://example.test/pr/999",
      state: "open",
      draft: false,
      base: "main",
      head: "minions/child-1",
      title: "child task",
    },
    attention: [],
    quickActions: [],
    branch: "minions/child-1",
    baseBranch: "main",
    repoId: "repo-1",
    stats: {
      turns: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: 0,
      toolCalls: 0,
    },
    provider: "mock",
    createdAt: now,
    updatedAt: now,
    childSlugs: [],
    metadata: {},
    ...overrides,
  };
}

interface SpawnRecord {
  args: {
    mode?: string;
    parentSlug?: string;
    title?: string;
    prompt?: string;
    metadata?: Record<string, unknown>;
  };
}

function makeCtx(opts: {
  sessions: Session[];
  spawnRecord?: SpawnRecord;
  spawnError?: string;
}): EngineContext {
  const sessions = new Map(opts.sessions.map((s) => [s.slug, s]));
  return {
    sessions: {
      get: (slug: string) => sessions.get(slug) ?? null,
      create: async (req: {
        mode?: string;
        parentSlug?: string;
        title?: string;
        prompt?: string;
        metadata?: Record<string, unknown>;
      }) => {
        if (opts.spawnError) throw new Error(opts.spawnError);
        if (opts.spawnRecord) opts.spawnRecord.args = req;
        return { slug: "verifier-1" } as unknown as Session;
      },
    },
    log: createLogger("error"),
  } as unknown as EngineContext;
}

describe("enqueueVerifyChild", () => {
  it("enqueues a verify-child job for a fresh session", () => {
    const env = setup();
    try {
      const job = enqueueVerifyChild(env.repo, "sess-a");
      assert.ok(job, "job created");
      assert.equal(job!.kind, "verify-child");
      assert.equal(job!.targetId, "sess-a");
    } finally {
      env.cleanup();
    }
  });

  it("returns null when a verify-child job is already pending", () => {
    const env = setup();
    try {
      enqueueVerifyChild(env.repo, "sess-b");
      const second = enqueueVerifyChild(env.repo, "sess-b");
      assert.equal(second, null, "second enqueue is a no-op");
    } finally {
      env.cleanup();
    }
  });
});

describe("createVerifyChildSpawnHandler", () => {
  it("spawns a verify-child session with the right prompt and metadata", async () => {
    const env = setup();
    try {
      const target = makeSession({ slug: "child-x", prompt: "foo" });
      const spawnRecord: SpawnRecord = { args: {} };
      const ctx = makeCtx({ sessions: [target], spawnRecord });
      const handler = createVerifyChildSpawnHandler();

      const job = enqueueVerifyChild(env.repo, "child-x")!;
      await handler(env.repo.get(job.id)!, ctx);

      assert.equal(spawnRecord.args.mode, "verify-child");
      assert.equal(spawnRecord.args.parentSlug, "child-x");
      assert.match(spawnRecord.args.title ?? "", /verify PR #999/);
      assert.match(spawnRecord.args.prompt ?? "", /gh pr diff 999/);
      assert.match(spawnRecord.args.prompt ?? "", /foo/);
      assert.equal(spawnRecord.args.metadata?.["kind"], "verify-child");
      assert.equal(spawnRecord.args.metadata?.["forSession"], "child-x");
      assert.equal(spawnRecord.args.metadata?.["prNumber"], 999);
    } finally {
      env.cleanup();
    }
  });

  it("skips spawn when the session has no open PR", async () => {
    const env = setup();
    try {
      const target = makeSession({ slug: "child-y", pr: undefined });
      const spawnRecord: SpawnRecord = { args: {} };
      const ctx = makeCtx({ sessions: [target], spawnRecord });
      const handler = createVerifyChildSpawnHandler();

      const job = enqueueVerifyChild(env.repo, "child-y")!;
      await handler(env.repo.get(job.id)!, ctx);

      assert.equal(spawnRecord.args.mode, undefined, "no spawn called");
    } finally {
      env.cleanup();
    }
  });

  it("skips spawn when verifyChildPassed is already true", async () => {
    const env = setup();
    try {
      const target = makeSession({
        slug: "child-z",
        metadata: { verifyChildPassed: true },
      });
      const spawnRecord: SpawnRecord = { args: {} };
      const ctx = makeCtx({ sessions: [target], spawnRecord });
      const handler = createVerifyChildSpawnHandler();

      const job = enqueueVerifyChild(env.repo, "child-z")!;
      await handler(env.repo.get(job.id)!, ctx);

      assert.equal(spawnRecord.args.mode, undefined, "no spawn after pass");
    } finally {
      env.cleanup();
    }
  });

  it("skips spawn when an active verifier child already exists", async () => {
    const env = setup();
    try {
      const verifierChild = makeSession({
        slug: "verifier-existing",
        status: "running",
        mode: "verify-child",
        metadata: { kind: "verify-child" },
      });
      const target = makeSession({
        slug: "child-w",
        childSlugs: ["verifier-existing"],
      });
      const spawnRecord: SpawnRecord = { args: {} };
      const ctx = makeCtx({ sessions: [target, verifierChild], spawnRecord });
      const handler = createVerifyChildSpawnHandler();

      const job = enqueueVerifyChild(env.repo, "child-w")!;
      await handler(env.repo.get(job.id)!, ctx);

      assert.equal(spawnRecord.args.mode, undefined, "no double spawn");
    } finally {
      env.cleanup();
    }
  });
});

describe("parseVerifierVerdict", () => {
  function evt(text: string, seq = 1): TranscriptEvent {
    return {
      id: `e-${seq}`,
      sessionSlug: "v",
      seq,
      turn: 1,
      timestamp: new Date().toISOString(),
      kind: "assistant_text",
      text,
    } as TranscriptEvent;
  }

  it("returns pass when last assistant_text starts with PASS", () => {
    const result = parseVerifierVerdict([evt("PASS\n\nLooks fine.")]);
    assert.equal(result.kind, "pass");
  });

  it("returns fail with feedback from fix-prompt block", () => {
    const result = parseVerifierVerdict([
      evt("FAIL\n\nGap 1: missing button\n\n```fix-prompt\nAdd the X button per criterion 3.\n```"),
    ]);
    assert.equal(result.kind, "fail");
    assert.equal(result.feedback, "Add the X button per criterion 3.");
  });

  it("uses the last assistant_text when there are multiple", () => {
    const result = parseVerifierVerdict([
      evt("PASS — initial check", 1),
      evt("FAIL — wait, missed something", 2),
    ]);
    assert.equal(result.kind, "fail");
  });

  it("returns unknown when no PASS/FAIL token found", () => {
    const result = parseVerifierVerdict([evt("Looks good to me, all done.")]);
    assert.equal(result.kind, "unknown");
  });

  it("returns unknown when there is no assistant_text", () => {
    const result = parseVerifierVerdict([]);
    assert.equal(result.kind, "unknown");
  });

  it("falls back to plain text feedback when no fix-prompt block exists", () => {
    const result = parseVerifierVerdict([evt("FAIL\n\nButton is wrong color.")]);
    assert.equal(result.kind, "fail");
    assert.match(result.feedback ?? "", /Button is wrong color/);
  });
});

describe("readVerifyChildAttempts", () => {
  it("returns 0 for missing or invalid metadata", () => {
    assert.equal(readVerifyChildAttempts({}), 0);
    assert.equal(readVerifyChildAttempts({ verifyChildAttempts: -1 }), 0);
    assert.equal(readVerifyChildAttempts({ verifyChildAttempts: "two" }), 0);
  });

  it("returns the integer count", () => {
    assert.equal(readVerifyChildAttempts({ verifyChildAttempts: 1 }), 1);
    assert.equal(readVerifyChildAttempts({ verifyChildAttempts: 1.7 }), 1);
  });
});

describe("buildVerifierPrompt", () => {
  it("includes PR number, original task, and the gh commands", () => {
    const prompt = buildVerifierPrompt({ prNumber: 42, originalTaskPrompt: "add toggle" });
    assert.match(prompt, /PR TO VERIFY: #42/);
    assert.match(prompt, /add toggle/);
    assert.match(prompt, /gh pr diff 42/);
    assert.match(prompt, /PASS\b/);
    assert.match(prompt, /FAIL\b/);
  });
});

describe("VERIFY_CHILD_MAX_RETRIES", () => {
  it("is set to 1 (one retry max per user decision)", () => {
    assert.equal(VERIFY_CHILD_MAX_RETRIES, 1);
  });
});
