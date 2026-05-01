import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import type { Session, SessionStatus, PRSummary } from "@minions/shared";
import { openStore } from "../../store/sqlite.js";
import { createLogger } from "../../logger.js";
import { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import type { EngineContext } from "../../context.js";
import { createCiPollHandler } from "./ciPoll.js";

interface MakeSessionInput {
  slug: string;
  status?: SessionStatus;
  pr?: PRSummary;
}

function makeSession({ slug, status = "running", pr }: MakeSessionInput): Session {
  const now = new Date().toISOString();
  return {
    slug,
    title: slug,
    prompt: "test",
    mode: "task",
    status,
    pr,
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
    createdAt: now,
    updatedAt: now,
    childSlugs: [],
    metadata: {},
  };
}

function pr(number: number, state: PRSummary["state"] = "open"): PRSummary {
  return {
    number,
    url: `https://example.test/pr/${number}`,
    state,
    draft: false,
    base: "main",
    head: `feature-${number}`,
    title: `PR ${number}`,
  };
}

interface Env {
  db: Database.Database;
  repo: AutomationJobRepo;
  cleanup: () => void;
}

function setup(): Env {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-cipoll-"));
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

interface MockCtxOptions {
  before: Session | null;
  after?: Session | null;
  pollCalls: string[];
}

function makeCtx(opts: MockCtxOptions): EngineContext {
  let returnAfter = false;
  return {
    sessions: {
      get: (slug: string) => {
        if (!returnAfter) return opts.before && opts.before.slug === slug ? opts.before : null;
        const next = opts.after === undefined ? opts.before : opts.after;
        return next && next.slug === slug ? next : null;
      },
    },
    ci: {
      poll: async (slug: string) => {
        opts.pollCalls.push(slug);
        returnAfter = true;
      },
      onPrUpdated: async () => {},
    },
  } as unknown as EngineContext;
}

describe("ciPoll handler", () => {
  it("re-enqueues a follow-up job when PR is still open after polling", async () => {
    const env = setup();
    try {
      const session = makeSession({ slug: "s1", status: "running", pr: pr(1, "open") });
      const pollCalls: string[] = [];
      const ctx = makeCtx({ before: session, after: session, pollCalls });

      const handler = createCiPollHandler({ repo: env.repo });
      const job = env.repo.enqueue({
        kind: "ci-poll",
        targetKind: "session",
        targetId: "s1",
        payload: { sessionSlug: "s1" },
      });

      await handler(env.repo.get(job.id)!, ctx);

      assert.deepEqual(pollCalls, ["s1"]);
      const queued = env.repo.findByTarget("session", "s1");
      const followUps = queued.filter((j) => j.id !== job.id && j.kind === "ci-poll");
      assert.equal(followUps.length, 1, "expected one follow-up ci-poll job");
      const followUp = followUps[0]!;
      assert.equal(followUp.status, "pending");
      const delayMs = new Date(followUp.nextRunAt).getTime() - Date.now();
      assert.ok(
        delayMs > 25_000 && delayMs < 35_000,
        `expected delay near 30s, got ${delayMs}ms`,
      );
    } finally {
      env.cleanup();
    }
  });

  it("does not re-enqueue when the PR has merged after polling", async () => {
    const env = setup();
    try {
      const before = makeSession({ slug: "s2", status: "running", pr: pr(2, "open") });
      const after = makeSession({ slug: "s2", status: "completed", pr: pr(2, "merged") });
      const pollCalls: string[] = [];
      const ctx = makeCtx({ before, after, pollCalls });

      const handler = createCiPollHandler({ repo: env.repo });
      const job = env.repo.enqueue({
        kind: "ci-poll",
        targetKind: "session",
        targetId: "s2",
        payload: { sessionSlug: "s2" },
      });

      await handler(env.repo.get(job.id)!, ctx);

      assert.deepEqual(pollCalls, ["s2"]);
      const queued = env.repo.findByTarget("session", "s2");
      const followUps = queued.filter((j) => j.id !== job.id && j.kind === "ci-poll");
      assert.equal(followUps.length, 0, "expected no follow-up ci-poll job after merge");
    } finally {
      env.cleanup();
    }
  });

  it("succeeds without re-enqueue or poll when the session is missing", async () => {
    const env = setup();
    try {
      const pollCalls: string[] = [];
      const ctx = makeCtx({ before: null, pollCalls });

      const handler = createCiPollHandler({ repo: env.repo });
      const job = env.repo.enqueue({
        kind: "ci-poll",
        targetKind: "session",
        targetId: "missing",
        payload: { sessionSlug: "missing" },
      });

      await handler(env.repo.get(job.id)!, ctx);

      assert.deepEqual(pollCalls, [], "should not call ctx.ci.poll when session is missing");
      const queued = env.repo.findByTarget("session", "missing");
      const followUps = queued.filter((j) => j.id !== job.id && j.kind === "ci-poll");
      assert.equal(followUps.length, 0);
    } finally {
      env.cleanup();
    }
  });
});
