import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AuditEvent, PRSummary, RepoBinding, Session } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { EventBus } from "../bus/eventBus.js";
import type { DagRepo } from "../dag/model.js";
import {
  LandingManager,
  type EditPullRequestBaseFn,
  type EnsurePullRequestFn,
  type PushBranchFn,
  type SessionStateUpdater,
} from "./index.js";
import { RestackManager } from "./restack.js";
import { KeyedMutex } from "../util/mutex.js";
import { createLogger } from "../logger.js";

interface OrderHarness {
  ctx: EngineContext;
  audit: AuditEvent[];
  callOrder: string[];
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

function makeHarness(opts: { session: Session; repo?: RepoBinding | null }): OrderHarness {
  const audit: AuditEvent[] = [];
  const callOrder: string[] = [];
  const sessionMap = new Map([[opts.session.slug, opts.session]]);
  const repoBinding =
    opts.repo === undefined
      ? ({ id: "repo-1", label: "repo-1", remote: "https://github.com/acme/repo.git" } as RepoBinding)
      : opts.repo;

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
      markWaitingInput: () => {},
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
    env: {} as EngineContext["env"],
    log: createLogger("error"),
    db: {} as EngineContext["db"],
    workspaceDir: "/tmp",
    features: () => [],
    featuresPending: () => [],
    repos: () => (repoBinding ? [repoBinding] : []),
    shutdown: async () => {},
  };

  return { ctx, audit, callOrder };
}

const noopDagRepo: DagRepo = { list: () => [] } as unknown as DagRepo;

function makeManager(
  h: OrderHarness,
  pushBranch: PushBranchFn,
  ensurePullRequest: EnsurePullRequestFn,
): LandingManager {
  const log = createLogger("error");
  const restack = new RestackManager(h.ctx, noopDagRepo, log);
  return new LandingManager(h.ctx, noopDagRepo, restack, log, {
    pushBranch,
    ensurePullRequest,
  });
}

describe("LandingManager.ensurePushedAndPRed", () => {
  test("pushes branch before opening PR", async () => {
    const session = buildSession("worker");
    const h = makeHarness({ session });

    const pushBranch: PushBranchFn = async () => {
      h.callOrder.push("push");
    };
    const ensurePullRequest: EnsurePullRequestFn = async () => {
      h.callOrder.push("pr");
      return null;
    };

    const manager = makeManager(h, pushBranch, ensurePullRequest);
    await manager.ensurePushedAndPRed("worker");

    assert.deepEqual(h.callOrder, ["push", "pr"], "push runs before PR creation");

    const auditActions = h.audit.map((e) => e.action);
    const pushStartIdx = auditActions.indexOf("landing.push.start");
    const pushDoneIdx = auditActions.indexOf("landing.push.complete");
    const prStartIdx = auditActions.indexOf("landing.pr.ensure.start");
    const prDoneIdx = auditActions.indexOf("landing.pr.ensure.complete");

    assert.ok(pushStartIdx >= 0, "push start audited");
    assert.ok(pushDoneIdx > pushStartIdx, "push complete audited after start");
    assert.ok(prStartIdx > pushDoneIdx, "PR start audited after push complete");
    assert.ok(prDoneIdx > prStartIdx, "PR complete audited after PR start");
  });

  test("does not open PR when push fails", async () => {
    const session = buildSession("worker");
    const h = makeHarness({ session });

    const pushBranch: PushBranchFn = async () => {
      h.callOrder.push("push");
      throw new Error("push exploded");
    };
    const ensurePullRequest: EnsurePullRequestFn = async () => {
      h.callOrder.push("pr");
      return null;
    };

    const manager = makeManager(h, pushBranch, ensurePullRequest);

    await assert.rejects(() => manager.ensurePushedAndPRed("worker"), /push exploded/);

    assert.deepEqual(h.callOrder, ["push"], "PR not opened when push fails");

    const auditActions = h.audit.map((e) => e.action);
    assert.ok(auditActions.includes("landing.push.start"), "push start recorded");
    assert.ok(auditActions.includes("landing.push.failed"), "push failure recorded");
    assert.ok(!auditActions.includes("landing.pr.ensure.start"), "PR start not recorded");
  });

  test("openForReview pushes branch + opens PR but never merges", async () => {
    const session = buildSession("worker");
    const h = makeHarness({ session });
    const sessionMap = new Map<string, Session>([[session.slug, session]]);
    h.ctx.sessions.get = (slug) => sessionMap.get(slug) ?? null;

    const summary: PRSummary = {
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
      state: "open",
      draft: false,
      base: "main",
      head: session.branch ?? "minions/worker",
      title: session.title,
    };

    const pushBranch: PushBranchFn = async () => {
      h.callOrder.push("push");
    };
    const ensurePullRequest: EnsurePullRequestFn = async () => {
      h.callOrder.push("pr");
      sessionMap.set(session.slug, { ...session, pr: summary });
      return summary;
    };

    const manager = makeManager(h, pushBranch, ensurePullRequest);
    const result = await manager.openForReview("worker");

    assert.deepEqual(h.callOrder, ["push", "pr"], "push then PR, no merge step in between or after");
    assert.equal(result?.number, 42);
    assert.equal(result?.state, "open");
    assert.notEqual(result?.state, "merged", "openForReview must not merge");

    const auditActions = h.audit.map((e) => e.action);
    assert.ok(auditActions.includes("landing.push.complete"), "push complete recorded");
    assert.ok(auditActions.includes("landing.pr.ensure.complete"), "PR ensure complete recorded");
    assert.ok(
      !auditActions.some((a) => a.startsWith("landing.merge")),
      "no merge audit events should be emitted",
    );
  });

  test("openForReview throws when push fails and never opens a PR", async () => {
    const session = buildSession("worker");
    const h = makeHarness({ session });

    const pushBranch: PushBranchFn = async () => {
      h.callOrder.push("push");
      throw new Error("push exploded");
    };
    const ensurePullRequest: EnsurePullRequestFn = async () => {
      h.callOrder.push("pr");
      return null;
    };

    const manager = makeManager(h, pushBranch, ensurePullRequest);

    await assert.rejects(() => manager.openForReview("worker"), /push exploded/);
    assert.deepEqual(h.callOrder, ["push"], "PR not opened after push failure");
  });

  test("skips push and PR when remote is offline (file path)", async () => {
    const session = buildSession("worker");
    const h = makeHarness({
      session,
      repo: { id: "repo-1", label: "repo-1", remote: "/var/local/repo.git" },
    });

    const pushBranch: PushBranchFn = async () => {
      h.callOrder.push("push");
    };
    const ensurePullRequest: EnsurePullRequestFn = async () => {
      h.callOrder.push("pr");
      return null;
    };

    const manager = makeManager(h, pushBranch, ensurePullRequest);
    await manager.ensurePushedAndPRed("worker");

    assert.deepEqual(h.callOrder, [], "neither push nor PR when offline");
    const skipped = h.audit.find((e) => e.action === "landing.push_and_pr.skipped");
    assert.ok(skipped, "skip event audited");
    assert.equal((skipped?.detail as { reason: string } | undefined)?.reason, "offline-remote");
  });
});

interface UpstreamHarness {
  ctx: EngineContext;
  audit: AuditEvent[];
  events: Array<{ kind: string; [k: string]: unknown }>;
  retryCalls: string[];
  baseEdits: Array<{ slug: string; baseBranch: string }>;
  prEdits: Array<{ slug: string; pr: PRSummary | null }>;
  ghCalls: Array<{ prNumber: number; newBase: string; cwd: string }>;
  sessionMap: Map<string, Session>;
  updater: SessionStateUpdater;
}

function makeUpstreamHarness(opts: {
  sessions: Session[];
  repo?: RepoBinding;
}): UpstreamHarness {
  const audit: AuditEvent[] = [];
  const events: Array<{ kind: string; [k: string]: unknown }> = [];
  const retryCalls: string[] = [];
  const baseEdits: Array<{ slug: string; baseBranch: string }> = [];
  const prEdits: Array<{ slug: string; pr: PRSummary | null }> = [];
  const ghCalls: Array<{ prNumber: number; newBase: string; cwd: string }> = [];
  const sessionMap = new Map(opts.sessions.map((s) => [s.slug, s]));
  const repoBinding =
    opts.repo ?? ({ id: "repo-1", label: "repo-1", remote: "https://github.com/acme/repo.git" } as RepoBinding);

  const updater: SessionStateUpdater = {
    update(slug, patch) {
      const current = sessionMap.get(slug);
      if (!current) return;
      const next: Session = { ...current, baseBranch: patch.baseBranch ?? current.baseBranch };
      sessionMap.set(slug, next);
      baseEdits.push({ slug, baseBranch: patch.baseBranch ?? current.baseBranch ?? "" });
    },
    setPr(slug, pr) {
      const current = sessionMap.get(slug);
      if (!current) return;
      const next: Session = { ...current, pr: pr ?? undefined };
      sessionMap.set(slug, next);
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
      markWaitingInput: () => {},
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
      },
      onUpstreamMerged: async () => {},
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
    env: {} as EngineContext["env"],
    log: createLogger("error"),
    db: {} as EngineContext["db"],
    workspaceDir: "/tmp",
    features: () => [],
    featuresPending: () => [],
    repos: () => [repoBinding],
    shutdown: async () => {},
  };

  return { ctx, audit, events, retryCalls, baseEdits, prEdits, ghCalls, sessionMap, updater };
}

const noopDagRepoForUpstream: DagRepo = { list: () => [] } as unknown as DagRepo;

describe("LandingManager.onUpstreamMerged", () => {
  test("updates child base, edits PR base on GitHub, and triggers restack", async () => {
    const parent = buildSession("parent", {
      branch: "minions/parent",
      baseBranch: "main",
    });
    const childPr: PRSummary = {
      number: 99,
      url: "https://github.com/acme/repo/pull/99",
      state: "open",
      draft: false,
      base: "minions/parent",
      head: "minions/child",
      title: "child",
    };
    const child = buildSession("child", {
      branch: "minions/child",
      baseBranch: "minions/parent",
      pr: childPr,
    });

    const h = makeUpstreamHarness({ sessions: [parent, child] });

    const editPullRequestBase: EditPullRequestBaseFn = async (args) => {
      h.ghCalls.push({ prNumber: args.prNumber, newBase: args.newBase, cwd: args.cwd });
    };

    const log = createLogger("error");
    const restack = new RestackManager(h.ctx, noopDagRepoForUpstream, log);
    const manager = new LandingManager(h.ctx, noopDagRepoForUpstream, restack, log, {
      editPullRequestBase,
      sessionRepo: h.updater,
    });

    await manager.onUpstreamMerged("parent");

    assert.deepEqual(
      h.baseEdits,
      [{ slug: "child", baseBranch: "main" }],
      "child baseBranch updated to parent's baseBranch",
    );
    assert.equal(h.ghCalls.length, 1, "gh pr edit invoked once");
    assert.deepEqual(h.ghCalls[0], {
      prNumber: 99,
      newBase: "main",
      cwd: child.worktreePath,
    });
    assert.equal(h.prEdits.length, 1, "child PR record updated locally");
    assert.equal(h.prEdits[0]?.pr?.base, "main", "stored PR base reflects new base");
    assert.deepEqual(h.retryCalls, ["child"], "child rebase triggered exactly once");
    const auditActions = h.audit.map((e) => e.action);
    assert.ok(
      auditActions.includes("landing.upstream_merged"),
      "upstream merge audited",
    );
  });

  test("skips gh pr edit when child has no open PR but still restacks", async () => {
    const parent = buildSession("parent", {
      branch: "minions/parent",
      baseBranch: "main",
    });
    const child = buildSession("child", {
      branch: "minions/child",
      baseBranch: "minions/parent",
    });

    const h = makeUpstreamHarness({ sessions: [parent, child] });

    const editPullRequestBase: EditPullRequestBaseFn = async (args) => {
      h.ghCalls.push({ prNumber: args.prNumber, newBase: args.newBase, cwd: args.cwd });
    };

    const log = createLogger("error");
    const restack = new RestackManager(h.ctx, noopDagRepoForUpstream, log);
    const manager = new LandingManager(h.ctx, noopDagRepoForUpstream, restack, log, {
      editPullRequestBase,
      sessionRepo: h.updater,
    });

    await manager.onUpstreamMerged("parent");

    assert.deepEqual(h.baseEdits, [{ slug: "child", baseBranch: "main" }]);
    assert.equal(h.ghCalls.length, 0, "no gh pr edit when no open PR");
    assert.deepEqual(h.retryCalls, ["child"]);
  });

  test("ignores sessions whose baseBranch does not match parent.branch", async () => {
    const parent = buildSession("parent", {
      branch: "minions/parent",
      baseBranch: "main",
    });
    const unrelated = buildSession("unrelated", {
      branch: "minions/unrelated",
      baseBranch: "main",
    });

    const h = makeUpstreamHarness({ sessions: [parent, unrelated] });

    const editPullRequestBase: EditPullRequestBaseFn = async () => {};
    const log = createLogger("error");
    const restack = new RestackManager(h.ctx, noopDagRepoForUpstream, log);
    const manager = new LandingManager(h.ctx, noopDagRepoForUpstream, restack, log, {
      editPullRequestBase,
      sessionRepo: h.updater,
    });

    await manager.onUpstreamMerged("parent");

    assert.deepEqual(h.baseEdits, [], "non-stacked siblings untouched");
    assert.deepEqual(h.retryCalls, [], "no rebase for non-stacked siblings");
  });
});
