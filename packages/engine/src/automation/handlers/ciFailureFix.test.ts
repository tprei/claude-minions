import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AttentionFlag, PRSummary, Session, SessionStatus } from "@minions/shared";
import { openStore } from "../../store/sqlite.js";
import { createLogger } from "../../logger.js";
import { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import type { EngineContext } from "../../context.js";
import { createCiFailureFixHandler, enqueueCiFailureFix } from "./ciFailureFix.js";

function setup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-cifailfix-"));
  const db = openStore({ path: path.join(tmpDir, "test.db"), log: createLogger("error") });
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

function makePr(state: PRSummary["state"] = "open"): PRSummary {
  return { number: 10, url: "https://example.test/pr/10", state, draft: false, base: "main", head: "feat", title: "PR 10" };
}

function makeSession(
  slug: string,
  opts: {
    status?: SessionStatus;
    hasPr?: boolean;
    prState?: PRSummary["state"];
    hasCiFailed?: boolean;
    kind?: string;
    childSlugs?: string[];
  } = {},
): Session {
  const now = new Date().toISOString();
  const attention: AttentionFlag[] = opts.hasCiFailed
    ? [{ kind: "ci_failed", message: "CI checks failed: lint", raisedAt: now }]
    : [];
  const pr = opts.hasPr !== false ? makePr(opts.prState ?? "open") : undefined;
  return {
    slug,
    title: slug,
    prompt: "test",
    mode: "task",
    status: opts.status ?? "running",
    pr,
    attention,
    quickActions: [],
    stats: { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 0, toolCalls: 0 },
    provider: "mock",
    createdAt: now,
    updatedAt: now,
    childSlugs: opts.childSlugs ?? [],
    metadata: opts.kind ? { kind: opts.kind } : {},
  };
}

interface CtxOpts {
  session: Session | null;
  children?: Session[];
  flagEnabled?: boolean;
  createError?: boolean;
}

interface CtxResult {
  ctx: EngineContext;
  createdSessions: import("@minions/shared").CreateSessionRequest[];
}

function makeCtx(opts: CtxOpts): CtxResult {
  const createdSessions: import("@minions/shared").CreateSessionRequest[] = [];
  const sessionMap = new Map<string, Session>();
  if (opts.session) sessionMap.set(opts.session.slug, opts.session);
  for (const c of opts.children ?? []) {
    sessionMap.set(c.slug, c);
  }

  const ctx = {
    sessions: {
      get: (slug: string) => sessionMap.get(slug) ?? null,
      create: async (req: import("@minions/shared").CreateSessionRequest) => {
        if (opts.createError) throw new Error("create failed");
        createdSessions.push(req);
        const now = new Date().toISOString();
        return {
          slug: `child-${createdSessions.length}`,
          title: req.title ?? "child",
          prompt: req.prompt,
          mode: req.mode ?? "task",
          status: "pending" as SessionStatus,
          attention: [],
          quickActions: [],
          stats: { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 0, toolCalls: 0 },
          provider: "mock",
          createdAt: now,
          updatedAt: now,
          childSlugs: [],
          metadata: req.metadata ?? {},
        } as Session;
      },
    },
    runtime: {
      effective: () => ({ autoFixCiOnFailure: opts.flagEnabled ?? true }),
    },
    log: createLogger("error"),
  } as unknown as EngineContext;

  return { ctx, createdSessions };
}

describe("enqueueCiFailureFix", () => {
  it("enqueues a ci-failure-fix job when none is in flight", () => {
    const env = setup();
    try {
      const job = enqueueCiFailureFix(env.repo, "sess-a");
      assert.ok(job);
      assert.equal(job!.kind, "ci-failure-fix");
      assert.equal(job!.status, "pending");
    } finally {
      env.cleanup();
    }
  });

  it("returns null when a job is already in flight (idempotency)", () => {
    const env = setup();
    try {
      const first = enqueueCiFailureFix(env.repo, "sess-b");
      assert.ok(first);
      const second = enqueueCiFailureFix(env.repo, "sess-b");
      assert.equal(second, null);
      assert.equal(env.repo.findByTarget("session", "sess-b").length, 1);
    } finally {
      env.cleanup();
    }
  });
});

describe("createCiFailureFixHandler", () => {
  it("spawns a fix-ci sub-session on happy path", async () => {
    const env = setup();
    try {
      const session = makeSession("s-happy", { hasCiFailed: true });
      const { ctx, createdSessions } = makeCtx({ session, flagEnabled: true });
      const handler = createCiFailureFixHandler({ automationRepo: env.repo });
      const job = env.repo.enqueue({ kind: "ci-failure-fix", targetKind: "session", targetId: "s-happy", payload: { sessionSlug: "s-happy" } });

      await handler(env.repo.get(job.id)!, ctx);

      assert.equal(createdSessions.length, 1);
      const req = createdSessions[0]!;
      assert.equal(req.mode, "task");
      assert.equal(req.parentSlug, "s-happy");
      assert.match(req.prompt, /CI is failing on PR #10/);
      assert.match(req.prompt, /CI checks failed: lint/);
      assert.equal((req.metadata as Record<string, unknown>)["kind"], "fix-ci");
    } finally {
      env.cleanup();
    }
  });

  it("exits without spawning when autoFixCiOnFailure flag is off", async () => {
    const env = setup();
    try {
      const session = makeSession("s-flag-off", { hasCiFailed: true });
      const { ctx, createdSessions } = makeCtx({ session, flagEnabled: false });
      const handler = createCiFailureFixHandler({ automationRepo: env.repo });
      const job = env.repo.enqueue({ kind: "ci-failure-fix", targetKind: "session", targetId: "s-flag-off", payload: { sessionSlug: "s-flag-off" } });

      await handler(env.repo.get(job.id)!, ctx);

      assert.equal(createdSessions.length, 0);
    } finally {
      env.cleanup();
    }
  });

  it("skips spawning when session itself is a fix-ci session (recursion guard)", async () => {
    const env = setup();
    try {
      const session = makeSession("s-fix-ci", { hasCiFailed: true, kind: "fix-ci" });
      const { ctx, createdSessions } = makeCtx({ session, flagEnabled: true });
      const handler = createCiFailureFixHandler({ automationRepo: env.repo });
      const job = env.repo.enqueue({ kind: "ci-failure-fix", targetKind: "session", targetId: "s-fix-ci", payload: { sessionSlug: "s-fix-ci" } });

      await handler(env.repo.get(job.id)!, ctx);

      assert.equal(createdSessions.length, 0);
    } finally {
      env.cleanup();
    }
  });

  it("skips spawning when an active fix-ci child already exists", async () => {
    const env = setup();
    try {
      const child = makeSession("child-running", { kind: "fix-ci", status: "running" });
      const session = makeSession("s-has-child", { hasCiFailed: true, childSlugs: ["child-running"] });
      const { ctx, createdSessions } = makeCtx({ session, children: [child], flagEnabled: true });
      const handler = createCiFailureFixHandler({ automationRepo: env.repo });
      const job = env.repo.enqueue({ kind: "ci-failure-fix", targetKind: "session", targetId: "s-has-child", payload: { sessionSlug: "s-has-child" } });

      await handler(env.repo.get(job.id)!, ctx);

      assert.equal(createdSessions.length, 0);
    } finally {
      env.cleanup();
    }
  });

  it("spawns when all fix-ci children are terminal", async () => {
    const env = setup();
    try {
      const child = makeSession("child-done", { kind: "fix-ci", status: "completed" });
      const session = makeSession("s-terminal-child", { hasCiFailed: true, childSlugs: ["child-done"] });
      const { ctx, createdSessions } = makeCtx({ session, children: [child], flagEnabled: true });
      const handler = createCiFailureFixHandler({ automationRepo: env.repo });
      const job = env.repo.enqueue({ kind: "ci-failure-fix", targetKind: "session", targetId: "s-terminal-child", payload: { sessionSlug: "s-terminal-child" } });

      await handler(env.repo.get(job.id)!, ctx);

      assert.equal(createdSessions.length, 1);
    } finally {
      env.cleanup();
    }
  });

  it("exits when ci_failed flag is no longer present", async () => {
    const env = setup();
    try {
      const session = makeSession("s-no-fail", { hasCiFailed: false });
      const { ctx, createdSessions } = makeCtx({ session, flagEnabled: true });
      const handler = createCiFailureFixHandler({ automationRepo: env.repo });
      const job = env.repo.enqueue({ kind: "ci-failure-fix", targetKind: "session", targetId: "s-no-fail", payload: { sessionSlug: "s-no-fail" } });

      await handler(env.repo.get(job.id)!, ctx);

      assert.equal(createdSessions.length, 0);
    } finally {
      env.cleanup();
    }
  });

  it("does not throw when sessions.create fails", async () => {
    const env = setup();
    try {
      const session = makeSession("s-create-err", { hasCiFailed: true });
      const { ctx } = makeCtx({ session, flagEnabled: true, createError: true });
      const handler = createCiFailureFixHandler({ automationRepo: env.repo });
      const job = env.repo.enqueue({ kind: "ci-failure-fix", targetKind: "session", targetId: "s-create-err", payload: { sessionSlug: "s-create-err" } });

      await assert.doesNotReject(() => handler(env.repo.get(job.id)!, ctx));
    } finally {
      env.cleanup();
    }
  });
});
