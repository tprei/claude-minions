import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AuditEvent, PRSummary, RepoBinding, Session } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { EventBus } from "../bus/eventBus.js";
import { KeyedMutex } from "../util/mutex.js";
import { createLogger } from "../logger.js";
import {
  createEnsurePullRequest,
  normalizeReviewDecision,
  type RunGhFn,
} from "./openPR.js";
import type { SessionStateUpdater } from "./sessionStateUpdater.js";

describe("normalizeReviewDecision", () => {
  test("maps gh uppercase decisions to lowercase enum values", () => {
    assert.equal(normalizeReviewDecision("APPROVED"), "approved");
    assert.equal(normalizeReviewDecision("CHANGES_REQUESTED"), "changes_requested");
    assert.equal(normalizeReviewDecision("COMMENTED"), "commented");
    assert.equal(normalizeReviewDecision("REVIEW_REQUIRED"), "review_required");
  });

  test("passes through already-lowercase values", () => {
    assert.equal(normalizeReviewDecision("approved"), "approved");
    assert.equal(normalizeReviewDecision("changes_requested"), "changes_requested");
  });

  test("returns null for missing or empty decision", () => {
    assert.equal(normalizeReviewDecision(null), null);
    assert.equal(normalizeReviewDecision(undefined), null);
    assert.equal(normalizeReviewDecision(""), null);
    assert.equal(normalizeReviewDecision("   "), null);
  });

  test("returns null for unknown strings rather than passing them through", () => {
    assert.equal(normalizeReviewDecision("dismissed"), null);
    assert.equal(normalizeReviewDecision("PENDING"), null);
  });

  test("returns null for non-string values", () => {
    assert.equal(normalizeReviewDecision(42), null);
    assert.equal(normalizeReviewDecision({}), null);
    assert.equal(normalizeReviewDecision(true), null);
  });
});

interface EnsureHarness {
  ctx: EngineContext;
  audit: AuditEvent[];
  sessionMap: Map<string, Session>;
  prEdits: Array<{ slug: string; pr: PRSummary | null }>;
  updater: SessionStateUpdater;
}

function buildSession(slug: string, overrides: Partial<Session> = {}): Session {
  return {
    slug,
    title: `pr-title-for-${slug}`,
    prompt: "do work",
    mode: "task",
    status: "running",
    attention: [],
    quickActions: [],
    branch: `minions/${slug}`,
    baseBranch: "main",
    worktreePath: `/tmp/worktrees/${slug}`,
    repoId: "repo-1",
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

function makeHarness(opts: { session: Session; repo?: RepoBinding | null }): EnsureHarness {
  const audit: AuditEvent[] = [];
  const sessionMap = new Map([[opts.session.slug, opts.session]]);
  const prEdits: Array<{ slug: string; pr: PRSummary | null }> = [];
  const repoBinding =
    opts.repo === undefined
      ? ({ id: "repo-1", label: "repo-1", remote: "https://github.com/acme/repo.git" } as RepoBinding)
      : opts.repo;

  const updater: SessionStateUpdater = {
    update(slug, patch) {
      const cur = sessionMap.get(slug);
      if (!cur) return;
      sessionMap.set(slug, { ...cur, baseBranch: patch.baseBranch ?? cur.baseBranch });
    },
    setPr(slug, pr) {
      const cur = sessionMap.get(slug);
      if (!cur) return;
      sessionMap.set(slug, { ...cur, pr: pr ?? undefined });
      prEdits.push({ slug, pr });
    },
  };

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
      retryRebase: async () => {},
      onUpstreamMerged: async () => {},
      editPRBase: async () => {},
    },
    bus: {
      emit: () => {},
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
    mutex: new KeyedMutex(),
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
    repos: () => (repoBinding ? [repoBinding] : []),
    getRepo: (id) => (repoBinding && repoBinding.id === id ? repoBinding : null),
    shutdown: async () => {},
  };

  return { ctx, audit, sessionMap, prEdits, updater };
}

describe("ensurePullRequest idempotency", () => {
  test("reuses existing OPEN PR for the same head branch and audits ensure.reused", async () => {
    const session = buildSession("worker");
    const h = makeHarness({ session });

    const calls: string[][] = [];
    const runGh: RunGhFn = async (args) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([
          {
            number: 17,
            state: "OPEN",
            url: "https://github.com/acme/repo/pull/17",
          },
        ]);
      }
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({
          number: 17,
          url: "https://github.com/acme/repo/pull/17",
          state: "OPEN",
          title: session.title,
          baseRefName: "main",
          headRefName: session.branch,
          isDraft: false,
          reviewDecision: null,
        });
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const ensurePr = createEnsurePullRequest(runGh, { sessionRepo: h.updater });
    const summary = await ensurePr({ ctx: h.ctx, slug: "worker", log: createLogger("error") });

    assert.equal(summary?.number, 17);
    assert.equal(summary?.state, "open");
    assert.ok(
      !calls.some((c) => c[0] === "pr" && c[1] === "create"),
      "must not invoke gh pr create when an open PR already exists",
    );
    assert.equal(h.prEdits.length, 1, "PR persisted to session row");
    assert.equal(h.prEdits[0]?.pr?.number, 17);
    const reuseEvent = h.audit.find((e) => e.action === "landing.pr.ensure.reused");
    assert.ok(reuseEvent, "landing.pr.ensure.reused audited");
    assert.equal(
      (reuseEvent?.detail as { prNumber?: number } | undefined)?.prNumber,
      17,
    );
  });

  test("falls through to gh pr create when previous PR is CLOSED", async () => {
    const session = buildSession("worker");
    const h = makeHarness({ session });

    const calls: string[][] = [];
    const runGh: RunGhFn = async (args) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([
          { number: 8, state: "CLOSED", url: "https://github.com/acme/repo/pull/8" },
        ]);
      }
      if (args[0] === "pr" && args[1] === "create") {
        return "https://github.com/acme/repo/pull/9";
      }
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({
          number: 9,
          url: "https://github.com/acme/repo/pull/9",
          state: "OPEN",
          title: session.title,
          baseRefName: "main",
          headRefName: session.branch,
          isDraft: false,
          reviewDecision: null,
        });
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const ensurePr = createEnsurePullRequest(runGh, { sessionRepo: h.updater });
    const summary = await ensurePr({ ctx: h.ctx, slug: "worker", log: createLogger("error") });

    assert.equal(summary?.number, 9, "new PR created after closed one");
    assert.ok(
      calls.some((c) => c[0] === "pr" && c[1] === "create"),
      "gh pr create invoked for fresh PR",
    );
    assert.ok(
      !h.audit.some((e) => e.action === "landing.pr.ensure.reused"),
      "must not record reuse for a closed PR",
    );
  });

  test("creates a new PR when no PR exists for the branch", async () => {
    const session = buildSession("worker");
    const h = makeHarness({ session });

    const calls: string[][] = [];
    const runGh: RunGhFn = async (args) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([]);
      }
      if (args[0] === "pr" && args[1] === "create") {
        return "https://github.com/acme/repo/pull/42";
      }
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({
          number: 42,
          url: "https://github.com/acme/repo/pull/42",
          state: "OPEN",
          title: session.title,
          baseRefName: "main",
          headRefName: session.branch,
          isDraft: false,
          reviewDecision: null,
        });
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const ensurePr = createEnsurePullRequest(runGh, { sessionRepo: h.updater });
    const summary = await ensurePr({ ctx: h.ctx, slug: "worker", log: createLogger("error") });

    assert.equal(summary?.number, 42);
    assert.ok(
      calls.some((c) => c[0] === "pr" && c[1] === "list"),
      "lookup ran before create",
    );
    assert.ok(
      calls.some((c) => c[0] === "pr" && c[1] === "create"),
      "create ran when no existing PR found",
    );
    assert.equal(h.prEdits.length, 1, "PR persisted to session row");
  });
});
