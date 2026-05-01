import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AuditEvent, DAG, DAGNode, PRSummary, RepoBinding, Session } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { EventBus } from "../bus/eventBus.js";
import type { DagRepo } from "../dag/model.js";
import {
  LandingManager,
  type CommitsAheadFn,
  type EditPullRequestBaseFn,
  type EnsurePullRequestFn,
  type PushBranchFn,
  type RunGhInWorktreeFn,
  type SessionStateUpdater,
} from "./index.js";
import { RestackManager } from "./restack.js";
import type { BranchExistsFn, RebaseOntoFn } from "./baseResolver.js";
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
      setMetadata: () => {},
      markCompleted: () => {},
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

  return { ctx, audit, callOrder };
}

const noopDagRepo: DagRepo = {
  list: () => [],
  getNodeBySession: () => null,
  byNodeSession: () => null,
  getNode: () => null,
  updateNode: () => {
    throw new Error("noop dag repo: updateNode not implemented");
  },
} as unknown as DagRepo;

const alwaysExistsBranch = async () => true;
const noopRebase = async () => {};
const oneCommitAhead: CommitsAheadFn = async () => 1;

function makeManager(
  h: OrderHarness,
  pushBranch: PushBranchFn,
  ensurePullRequest: EnsurePullRequestFn,
  commitsAhead: CommitsAheadFn = oneCommitAhead,
): LandingManager {
  const log = createLogger("error");
  const restack = new RestackManager(h.ctx, noopDagRepo, log, {
    branchExistsOnRemote: alwaysExistsBranch,
    rebaseOnto: noopRebase,
  });
  return new LandingManager(h.ctx, noopDagRepo, restack, log, {
    pushBranch,
    ensurePullRequest,
    branchExistsOnRemote: alwaysExistsBranch,
    rebaseOnto: noopRebase,
    commitsAhead,
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

  test("skips push and PR when worktree has no commits ahead of base", async () => {
    const session = buildSession("verifier");
    const h = makeHarness({ session });

    const pushBranch: PushBranchFn = async () => {
      h.callOrder.push("push");
    };
    const ensurePullRequest: EnsurePullRequestFn = async () => {
      h.callOrder.push("pr");
      return null;
    };
    const commitsAhead: CommitsAheadFn = async () => 0;

    const manager = makeManager(h, pushBranch, ensurePullRequest, commitsAhead);
    await manager.ensurePushedAndPRed("verifier");

    assert.deepEqual(h.callOrder, [], "neither push nor PR when no commits ahead");
    const noChanges = h.audit.find((e) => e.action === "landing.no-changes");
    assert.ok(noChanges, "landing.no-changes audit emitted");
    const detail = noChanges?.detail as { branch?: string; baseBranch?: string } | undefined;
    assert.equal(detail?.branch, session.branch);
    assert.equal(detail?.baseBranch, session.baseBranch);

    const auditActions = h.audit.map((e) => e.action);
    assert.ok(!auditActions.includes("landing.push.start"), "push start not recorded");
    assert.ok(!auditActions.includes("landing.pr.ensure.start"), "PR start not recorded");
  });

  test("openForReview returns null when worktree has no commits ahead", async () => {
    const session = buildSession("verifier");
    const h = makeHarness({ session });

    const pushBranch: PushBranchFn = async () => {
      h.callOrder.push("push");
    };
    const ensurePullRequest: EnsurePullRequestFn = async () => {
      h.callOrder.push("pr");
      return null;
    };
    const commitsAhead: CommitsAheadFn = async () => 0;

    const manager = makeManager(h, pushBranch, ensurePullRequest, commitsAhead);
    const result = await manager.openForReview("verifier");

    assert.equal(result, null, "openForReview returns null on no-changes");
    assert.deepEqual(h.callOrder, [], "no push or PR attempted");
    assert.ok(
      h.audit.some((e) => e.action === "landing.no-changes"),
      "landing.no-changes audit emitted",
    );
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
      setMetadata: () => {},
      markCompleted: () => {},
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
      retryRebase: async (slug: string) => {
        retryCalls.push(slug);
      },
      onUpstreamMerged: async () => {},
      editPRBase: async () => {},
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
    repos: () => [repoBinding],
    getRepo: (id) => (repoBinding.id === id ? repoBinding : null),
    shutdown: async () => {},
  };

  return { ctx, audit, events, retryCalls, baseEdits, prEdits, ghCalls, sessionMap, updater };
}

const noopDagRepoForUpstream: DagRepo = {
  list: () => [],
  getNodeBySession: () => null,
  byNodeSession: () => null,
  getNode: () => null,
  updateNode: () => {
    throw new Error("noop dag repo: updateNode not implemented");
  },
} as unknown as DagRepo;

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
    const restack = new RestackManager(h.ctx, noopDagRepoForUpstream, log, {
      branchExistsOnRemote: alwaysExistsBranch,
      rebaseOnto: noopRebase,
      sessionRepo: h.updater,
    });
    const manager = new LandingManager(h.ctx, noopDagRepoForUpstream, restack, log, {
      branchExistsOnRemote: alwaysExistsBranch,
      rebaseOnto: noopRebase,
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
    const restack = new RestackManager(h.ctx, noopDagRepoForUpstream, log, {
      branchExistsOnRemote: alwaysExistsBranch,
      rebaseOnto: noopRebase,
      sessionRepo: h.updater,
    });
    const manager = new LandingManager(h.ctx, noopDagRepoForUpstream, restack, log, {
      branchExistsOnRemote: alwaysExistsBranch,
      rebaseOnto: noopRebase,
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
    const restack = new RestackManager(h.ctx, noopDagRepoForUpstream, log, {
      branchExistsOnRemote: alwaysExistsBranch,
      rebaseOnto: noopRebase,
      sessionRepo: h.updater,
    });
    const manager = new LandingManager(h.ctx, noopDagRepoForUpstream, restack, log, {
      branchExistsOnRemote: alwaysExistsBranch,
      rebaseOnto: noopRebase,
      editPullRequestBase,
      sessionRepo: h.updater,
    });

    await manager.onUpstreamMerged("parent");

    assert.deepEqual(h.baseEdits, [], "non-stacked siblings untouched");
    assert.deepEqual(h.retryCalls, [], "no rebase for non-stacked siblings");
  });
});

interface FakeDagRepoOpts {
  dag: DAG;
  nodes: DAGNode[];
}

function makeFakeDagRepo(opts: FakeDagRepoOpts): DagRepo {
  const nodesById = new Map(opts.nodes.map((n) => [n.id, n] as const));
  const nodesBySession = new Map<string, DAGNode>();
  for (const node of opts.nodes) {
    if (node.sessionSlug) nodesBySession.set(node.sessionSlug, node);
  }
  const repo = {
    list: () => [opts.dag],
    get: (id: string) => (id === opts.dag.id ? opts.dag : null),
    listNodes: () => opts.nodes,
    getNode: (id: string) => nodesById.get(id) ?? null,
    getNodeBySession: (slug: string) => nodesBySession.get(slug) ?? null,
    byNodeSession: (slug: string) => (nodesBySession.has(slug) ? opts.dag : null),
    byRootSession: () => null,
    updateNode: (id: string, patch: Partial<DAGNode>) => {
      const cur = nodesById.get(id);
      if (!cur) throw new Error(`fake repo: node not found ${id}`);
      const updated: DAGNode = { ...cur, ...patch };
      nodesById.set(id, updated);
      if (cur.sessionSlug) nodesBySession.set(cur.sessionSlug, updated);
      return updated;
    },
  };
  return repo as unknown as DagRepo;
}

describe("LandingManager.openForReview live-base re-resolution", () => {
  test("falls back to surviving ancestor when dep branch was deleted on origin", async () => {
    const rootSession = buildSession("root", {
      branch: "minions/root",
      baseBranch: "main",
    });
    const midSession = buildSession("mid", {
      branch: "minions/mid",
      baseBranch: "minions/root",
    });
    const leafSession = buildSession("leaf", {
      branch: "minions/leaf",
      baseBranch: "minions/mid",
      mode: "dag-task",
    });

    const rootNode: DAGNode = {
      id: "node-root",
      title: "root",
      prompt: "",
      status: "landed",
      dependsOn: [],
      sessionSlug: "root",
      branch: "minions/root",
      baseBranch: "main",
      metadata: {},
    };
    const midNode: DAGNode = {
      id: "node-mid",
      title: "mid",
      prompt: "",
      status: "landed",
      dependsOn: ["node-root"],
      sessionSlug: "mid",
      branch: "minions/mid",
      baseBranch: "minions/root",
      metadata: {},
    };
    const leafNode: DAGNode = {
      id: "node-leaf",
      title: "leaf",
      prompt: "",
      status: "running",
      dependsOn: ["node-mid"],
      sessionSlug: "leaf",
      branch: "minions/leaf",
      baseBranch: "minions/mid",
      metadata: {},
    };
    const dag: DAG = {
      id: "dag-1",
      title: "stack",
      goal: "ship",
      baseBranch: "main",
      status: "active",
      nodes: [rootNode, midNode, leafNode],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };

    const dagRepo = makeFakeDagRepo({ dag, nodes: [rootNode, midNode, leafNode] });

    const h = makeUpstreamHarness({ sessions: [rootSession, midSession, leafSession] });

    const existsCalls: string[] = [];
    const branchExistsOnRemote: BranchExistsFn = async ({ branch }) => {
      existsCalls.push(branch);
      if (branch === "minions/mid") return false;
      return true;
    };

    const rebaseCalls: { worktreePath: string; branch: string }[] = [];
    const rebaseOnto: RebaseOntoFn = async (args) => {
      rebaseCalls.push(args);
    };

    const pushed: string[] = [];
    const pushBranch: PushBranchFn = async (_wt, branch) => {
      pushed.push(branch);
    };

    let prCallBaseBranch: string | null = null;
    const prSummary: PRSummary = {
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
      state: "open",
      draft: false,
      base: "minions/root",
      head: "minions/leaf",
      title: "leaf",
    };
    const ensurePullRequest: EnsurePullRequestFn = async ({ ctx, slug }) => {
      const s = ctx.sessions.get(slug);
      prCallBaseBranch = s?.baseBranch ?? null;
      h.sessionMap.set(slug, { ...(s as Session), pr: prSummary });
      return prSummary;
    };

    const log = createLogger("error");
    const restack = new RestackManager(h.ctx, dagRepo, log, {
      branchExistsOnRemote,
      rebaseOnto,
      sessionRepo: h.updater,
    });
    const manager = new LandingManager(h.ctx, dagRepo, restack, log, {
      branchExistsOnRemote,
      rebaseOnto,
      pushBranch,
      ensurePullRequest,
      commitsAhead: oneCommitAhead,
      sessionRepo: h.updater,
    });

    const result = await manager.openForReview("leaf");

    assert.equal(prCallBaseBranch, "minions/root", "PR ensured against re-resolved ancestor base");
    assert.equal(
      h.sessionMap.get("leaf")?.baseBranch,
      "minions/root",
      "session baseBranch persisted to surviving ancestor",
    );
    assert.deepEqual(
      rebaseCalls,
      [{ worktreePath: leafSession.worktreePath, branch: "minions/root" }],
      "local branch rebased onto new base before pushing",
    );
    assert.deepEqual(pushed, ["minions/leaf"], "push proceeded after rebase");
    assert.equal(result?.number, 1, "PR returned");

    const resolveAudit = h.audit.find((e) => e.action === "landing.base.resolved");
    assert.ok(resolveAudit, "landing.base.resolved audit emitted");
    assert.deepEqual(resolveAudit?.detail, {
      oldBase: "minions/mid",
      newBase: "minions/root",
      reason: "ancestor-fallback",
    });

    const updatedLeafNode = dagRepo.getNode("node-leaf");
    assert.equal(updatedLeafNode?.baseBranch, "minions/root", "dag node baseBranch updated");

    assert.ok(existsCalls.includes("minions/mid"), "checked deleted dep branch first");
    assert.ok(existsCalls.includes("minions/root"), "walked up to surviving ancestor");
  });

  test("falls back to dag baseBranch when no ancestor branch survives", async () => {
    const leafSession = buildSession("leaf", {
      branch: "minions/leaf",
      baseBranch: "minions/dead",
      mode: "dag-task",
    });
    const deadNode: DAGNode = {
      id: "node-dead",
      title: "dead",
      prompt: "",
      status: "landed",
      dependsOn: [],
      sessionSlug: undefined,
      branch: "minions/dead",
      baseBranch: "main",
      metadata: {},
    };
    const leafNode: DAGNode = {
      id: "node-leaf",
      title: "leaf",
      prompt: "",
      status: "running",
      dependsOn: ["node-dead"],
      sessionSlug: "leaf",
      branch: "minions/leaf",
      baseBranch: "minions/dead",
      metadata: {},
    };
    const dag: DAG = {
      id: "dag-2",
      title: "stack",
      goal: "ship",
      baseBranch: "main",
      status: "active",
      nodes: [deadNode, leafNode],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };
    const dagRepo = makeFakeDagRepo({ dag, nodes: [deadNode, leafNode] });
    const h = makeUpstreamHarness({ sessions: [leafSession] });

    const branchExistsOnRemote: BranchExistsFn = async ({ branch }) => branch === "main";
    const rebaseCalls: { worktreePath: string; branch: string }[] = [];
    const rebaseOnto: RebaseOntoFn = async (args) => {
      rebaseCalls.push(args);
    };

    const pushBranch: PushBranchFn = async () => {};
    const ensurePullRequest: EnsurePullRequestFn = async () => null;

    const log = createLogger("error");
    const restack = new RestackManager(h.ctx, dagRepo, log, {
      branchExistsOnRemote,
      rebaseOnto,
      sessionRepo: h.updater,
    });
    const manager = new LandingManager(h.ctx, dagRepo, restack, log, {
      branchExistsOnRemote,
      rebaseOnto,
      pushBranch,
      ensurePullRequest,
      commitsAhead: oneCommitAhead,
      sessionRepo: h.updater,
    });

    await manager.openForReview("leaf");

    assert.equal(h.sessionMap.get("leaf")?.baseBranch, "main");
    assert.deepEqual(rebaseCalls, [
      { worktreePath: leafSession.worktreePath, branch: "main" },
    ]);
    const resolveAudit = h.audit.find((e) => e.action === "landing.base.resolved");
    assert.equal(
      (resolveAudit?.detail as { reason: string } | undefined)?.reason,
      "dag-base-fallback",
    );
  });

  test("does nothing when intended base still exists on origin", async () => {
    const session = buildSession("solo", { branch: "minions/solo", baseBranch: "main" });
    const h = makeUpstreamHarness({ sessions: [session] });

    const branchExistsOnRemote: BranchExistsFn = async () => true;
    const rebaseCalls: { worktreePath: string; branch: string }[] = [];
    const rebaseOnto: RebaseOntoFn = async (args) => {
      rebaseCalls.push(args);
    };
    const pushBranch: PushBranchFn = async () => {};
    const ensurePullRequest: EnsurePullRequestFn = async () => null;

    const log = createLogger("error");
    const restack = new RestackManager(h.ctx, noopDagRepoForUpstream, log, {
      branchExistsOnRemote,
      rebaseOnto,
      sessionRepo: h.updater,
    });
    const manager = new LandingManager(h.ctx, noopDagRepoForUpstream, restack, log, {
      branchExistsOnRemote,
      rebaseOnto,
      pushBranch,
      ensurePullRequest,
      commitsAhead: oneCommitAhead,
      sessionRepo: h.updater,
    });

    await manager.openForReview("solo");

    assert.equal(rebaseCalls.length, 0, "no rebase when base survives");
    const resolveAudit = h.audit.find((e) => e.action === "landing.base.resolved");
    assert.equal(resolveAudit, undefined, "no resolution audit when base unchanged");
  });
});

interface LandHarness {
  ctx: EngineContext;
  audit: AuditEvent[];
  attentionCalls: Array<{ slug: string; flag: import("@minions/shared").AttentionFlag }>;
  prEdits: Array<{ slug: string; pr: PRSummary | null }>;
  sessionMap: Map<string, Session>;
  updater: SessionStateUpdater;
}

function makeLandHarness(opts: { session: Session }): LandHarness {
  const audit: AuditEvent[] = [];
  const attentionCalls: Array<{ slug: string; flag: import("@minions/shared").AttentionFlag }> = [];
  const prEdits: Array<{ slug: string; pr: PRSummary | null }> = [];
  const sessionMap = new Map([[opts.session.slug, opts.session]]);
  const repoBinding: RepoBinding = {
    id: "repo-1",
    label: "repo-1",
    remote: "https://github.com/acme/repo.git",
  };

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
      markWaitingInput: () => {},
      appendAttention: (slug, flag) => {
        attentionCalls.push({ slug, flag });
        const cur = sessionMap.get(slug);
        if (cur) sessionMap.set(slug, { ...cur, attention: [...cur.attention, flag] });
      },
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
    github: {
      enabled: () => false,
      fetchPR: async () => { throw new Error("not implemented"); },
    },
    stats: {} as EngineContext["stats"],
    cleanup: {} as EngineContext["cleanup"],
    env: {} as EngineContext["env"],
    log: createLogger("error"),
    db: {} as EngineContext["db"],
    workspaceDir: "/tmp",
    previousMarker: null,
    features: () => [],
    featuresPending: () => [],
    repos: () => [repoBinding],
    getRepo: (id) => (repoBinding.id === id ? repoBinding : null),
    shutdown: async () => {},
  };

  return { ctx, audit, attentionCalls, prEdits, sessionMap, updater };
}

describe("LandingManager.land safe merge", () => {
  test("skips merge with audit when PR is already MERGED", async () => {
    const summary: PRSummary = {
      number: 88,
      url: "https://github.com/acme/repo/pull/88",
      state: "open",
      draft: false,
      base: "main",
      head: "minions/done",
      title: "done",
    };
    const session = buildSession("done", { branch: "minions/done", pr: summary, worktreePath: "/tmp" });
    const h = makeLandHarness({ session });

    const ghCalls: string[][] = [];
    const runGh: RunGhInWorktreeFn = async (args) => {
      ghCalls.push(args);
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({ state: "MERGED", mergeable: "MERGEABLE" });
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const log = createLogger("error");
    const restack = new RestackManager(h.ctx, noopDagRepoForUpstream, log, {
      sessionRepo: h.updater,
    });
    const manager = new LandingManager(h.ctx, noopDagRepoForUpstream, restack, log, {
      pushBranch: async () => {},
      ensurePullRequest: async () => summary,
      branchExistsOnRemote: alwaysExistsBranch,
      rebaseOnto: noopRebase,
      commitsAhead: oneCommitAhead,
      runGh,
      sessionRepo: h.updater,
    });

    await manager.land("done", "squash", true);

    assert.ok(
      !ghCalls.some((c) => c[0] === "pr" && c[1] === "merge"),
      "must not invoke gh pr merge when PR is already merged",
    );
    const skipped = h.audit.find((e) => e.action === "landing.merge.skipped");
    assert.ok(skipped, "landing.merge.skipped audited");
    assert.equal(
      (skipped?.detail as { reason?: string } | undefined)?.reason,
      "already-merged",
    );
    assert.equal(h.attentionCalls.length, 0, "no attention raised on merged PR");
  });

  test("raises rebase_conflict attention without merging when mergeable is CONFLICTING", async () => {
    const summary: PRSummary = {
      number: 91,
      url: "https://github.com/acme/repo/pull/91",
      state: "open",
      draft: false,
      base: "main",
      head: "minions/conflict",
      title: "conflict",
    };
    const session = buildSession("conflict", { branch: "minions/conflict", pr: summary, worktreePath: "/tmp" });
    const h = makeLandHarness({ session });

    const ghCalls: string[][] = [];
    const runGh: RunGhInWorktreeFn = async (args) => {
      ghCalls.push(args);
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({ state: "OPEN", mergeable: "CONFLICTING" });
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const log = createLogger("error");
    const restack = new RestackManager(h.ctx, noopDagRepoForUpstream, log, {
      sessionRepo: h.updater,
    });
    const manager = new LandingManager(h.ctx, noopDagRepoForUpstream, restack, log, {
      pushBranch: async () => {},
      ensurePullRequest: async () => summary,
      branchExistsOnRemote: alwaysExistsBranch,
      rebaseOnto: noopRebase,
      commitsAhead: oneCommitAhead,
      runGh,
      sessionRepo: h.updater,
    });

    await manager.land("conflict", "squash", true);

    assert.ok(
      !ghCalls.some((c) => c[0] === "pr" && c[1] === "merge"),
      "must not invoke gh pr merge when mergeable is CONFLICTING",
    );
    assert.equal(h.attentionCalls.length, 1, "rebase_conflict attention raised once");
    assert.equal(h.attentionCalls[0]?.flag.kind, "rebase_conflict");
    const blocked = h.audit.find((e) => e.action === "landing.merge.blocked");
    assert.ok(blocked, "landing.merge.blocked audited");
    assert.equal(
      (blocked?.detail as { reason?: string } | undefined)?.reason,
      "conflicting",
    );
  });
});
