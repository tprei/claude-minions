import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { MergeReadiness, PRSummary, Session, SessionStatus } from "@minions/shared";
import { openStore } from "../../store/sqlite.js";
import { createLogger } from "../../logger.js";
import { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import type { EngineContext } from "../../context.js";
import { createLandReadyHandler, enqueueLandReady } from "./landReadyTrigger.js";

function setup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-landready-"));
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

function makeSession(slug: string, status: SessionStatus = "completed", hasPr = true): Session {
  const now = new Date().toISOString();
  const pr: PRSummary | undefined = hasPr
    ? { number: 1, url: "https://example.test/pr/1", state: "open", draft: false, base: "main", head: "feat", title: "PR 1" }
    : undefined;
  return {
    slug,
    title: slug,
    prompt: "test",
    mode: "task",
    status,
    pr,
    attention: [],
    quickActions: [],
    stats: { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 0, toolCalls: 0 },
    provider: "mock",
    createdAt: now,
    updatedAt: now,
    childSlugs: [],
    metadata: {},
  };
}

function makeCtx(opts: {
  session: Session | null;
  readinessStatus?: MergeReadiness["status"];
  readinessError?: boolean;
  flagEnabled?: boolean;
  landCalls?: string[];
  landError?: boolean;
}): EngineContext {
  const landCalls = opts.landCalls ?? [];
  return {
    sessions: {
      get: (slug: string) => opts.session?.slug === slug ? opts.session : null,
    },
    readiness: {
      compute: async (_slug: string): Promise<MergeReadiness> => {
        if (opts.readinessError) throw new Error("readiness probe failed");
        return {
          sessionSlug: _slug,
          status: opts.readinessStatus ?? "ready",
          checks: [],
          computedAt: new Date().toISOString(),
        };
      },
    },
    runtime: {
      effective: () => ({ autoLandReadyOnGreen: opts.flagEnabled ?? true }),
    },
    landing: {
      land: async (slug: string) => {
        if (opts.landError) throw new Error("land failed");
        landCalls.push(slug);
      },
    },
    log: createLogger("error"),
  } as unknown as EngineContext;
}

describe("enqueueLandReady", () => {
  it("enqueues a land-ready job when none is in flight", () => {
    const env = setup();
    try {
      const job = enqueueLandReady(env.repo, "sess-1");
      assert.ok(job, "job returned");
      assert.equal(job!.kind, "land-ready");
      assert.equal(job!.status, "pending");
    } finally {
      env.cleanup();
    }
  });

  it("returns null and skips enqueue when a job is already in flight (idempotency)", () => {
    const env = setup();
    try {
      const first = enqueueLandReady(env.repo, "sess-2");
      assert.ok(first);
      const second = enqueueLandReady(env.repo, "sess-2");
      assert.equal(second, null);
      const all = env.repo.findByTarget("session", "sess-2");
      assert.equal(all.length, 1);
    } finally {
      env.cleanup();
    }
  });
});

describe("createLandReadyHandler", () => {
  it("calls ctx.landing.land when flag enabled and session is ready", async () => {
    const env = setup();
    try {
      const landCalls: string[] = [];
      const session = makeSession("s-happy");
      const ctx = makeCtx({ session, flagEnabled: true, readinessStatus: "ready", landCalls });
      const handler = createLandReadyHandler({ automationRepo: env.repo });
      const job = env.repo.enqueue({ kind: "land-ready", targetKind: "session", targetId: "s-happy", payload: { sessionSlug: "s-happy" } });

      await handler(env.repo.get(job.id)!, ctx);

      assert.deepEqual(landCalls, ["s-happy"]);
    } finally {
      env.cleanup();
    }
  });

  it("exits without side effects when autoLandReadyOnGreen flag is off", async () => {
    const env = setup();
    try {
      const landCalls: string[] = [];
      const session = makeSession("s-flag-off");
      const ctx = makeCtx({ session, flagEnabled: false, readinessStatus: "ready", landCalls });
      const handler = createLandReadyHandler({ automationRepo: env.repo });
      const job = env.repo.enqueue({ kind: "land-ready", targetKind: "session", targetId: "s-flag-off", payload: { sessionSlug: "s-flag-off" } });

      await handler(env.repo.get(job.id)!, ctx);

      assert.deepEqual(landCalls, []);
    } finally {
      env.cleanup();
    }
  });

  it("does not call land when readiness is not ready", async () => {
    const env = setup();
    try {
      const landCalls: string[] = [];
      const session = makeSession("s-not-ready");
      const ctx = makeCtx({ session, flagEnabled: true, readinessStatus: "blocked", landCalls });
      const handler = createLandReadyHandler({ automationRepo: env.repo });
      const job = env.repo.enqueue({ kind: "land-ready", targetKind: "session", targetId: "s-not-ready", payload: { sessionSlug: "s-not-ready" } });

      await handler(env.repo.get(job.id)!, ctx);

      assert.deepEqual(landCalls, []);
    } finally {
      env.cleanup();
    }
  });

  it("does not throw when readiness probe throws", async () => {
    const env = setup();
    try {
      const session = makeSession("s-probe-err");
      const ctx = makeCtx({ session, flagEnabled: true, readinessError: true });
      const handler = createLandReadyHandler({ automationRepo: env.repo });
      const job = env.repo.enqueue({ kind: "land-ready", targetKind: "session", targetId: "s-probe-err", payload: { sessionSlug: "s-probe-err" } });

      await assert.doesNotReject(() => handler(env.repo.get(job.id)!, ctx));
    } finally {
      env.cleanup();
    }
  });

  it("does not throw when land fails", async () => {
    const env = setup();
    try {
      const session = makeSession("s-land-err");
      const ctx = makeCtx({ session, flagEnabled: true, readinessStatus: "ready", landError: true });
      const handler = createLandReadyHandler({ automationRepo: env.repo });
      const job = env.repo.enqueue({ kind: "land-ready", targetKind: "session", targetId: "s-land-err", payload: { sessionSlug: "s-land-err" } });

      await assert.doesNotReject(() => handler(env.repo.get(job.id)!, ctx));
    } finally {
      env.cleanup();
    }
  });

  it("exits when session has no open PR", async () => {
    const env = setup();
    try {
      const landCalls: string[] = [];
      const session = makeSession("s-no-pr", "completed", false);
      const ctx = makeCtx({ session, flagEnabled: true, readinessStatus: "ready", landCalls });
      const handler = createLandReadyHandler({ automationRepo: env.repo });
      const job = env.repo.enqueue({ kind: "land-ready", targetKind: "session", targetId: "s-no-pr", payload: { sessionSlug: "s-no-pr" } });

      await handler(env.repo.get(job.id)!, ctx);

      assert.deepEqual(landCalls, []);
    } finally {
      env.cleanup();
    }
  });
});
