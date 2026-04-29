import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AuditEvent, RepoBinding, Session } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { EventBus } from "../bus/eventBus.js";
import type { DagRepo } from "../dag/model.js";
import { LandingManager, type EnsurePullRequestFn, type PushBranchFn } from "./index.js";
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
    },
    landing: {
      land: async () => {},
      retryRebase: async () => {},
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
