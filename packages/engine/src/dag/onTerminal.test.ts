import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type {
  AttentionFlag,
  AutomationJob,
  DAG,
  DAGNode,
  PRSummary,
  QualityReport,
  ServerEvent,
  Session,
} from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { EventBus } from "../bus/eventBus.js";
import { DagTerminalHandler } from "./onTerminal.js";
import type { DagRepo } from "./model.js";
import type { DagScheduler } from "./scheduler.js";
import { createLogger } from "../logger.js";
import { migrations } from "../store/migrations.js";
import { SessionRepo } from "../store/repos/sessionRepo.js";
import { EngineError } from "../errors.js";
import type { AutomationJobRepo } from "../store/repos/automationJobRepo.js";

function makeNode(id: string, status: DAGNode["status"], sessionSlug?: string): DAGNode {
  return {
    id,
    title: id,
    prompt: `do ${id}`,
    status,
    dependsOn: [],
    sessionSlug,
    metadata: {},
  };
}

function makeDag(id: string, nodes: DAGNode[], rootSessionSlug?: string): DAG {
  const now = new Date().toISOString();
  return {
    id,
    title: "test dag",
    goal: "test goal",
    nodes,
    rootSessionSlug,
    createdAt: now,
    updatedAt: now,
    status: "active",
    metadata: {},
  };
}

function makeSession(slug: string, status: Session["status"] = "completed"): Session {
  return {
    slug,
    title: slug,
    prompt: "p",
    mode: "dag-task",
    status,
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    childSlugs: [],
    metadata: {},
  };
}

interface MockRepo {
  repo: DagRepo;
  patches: { id: string; patch: Partial<DAGNode> }[];
  getNode: (id: string) => DAGNode | null;
}

function makeMockRepo(dag: DAG): MockRepo {
  const nodes = new Map<string, DAGNode>(dag.nodes.map((n) => [n.id, n]));
  const patches: { id: string; patch: Partial<DAGNode> }[] = [];

  const repo = {
    getNodeBySession(slug: string): DAGNode | null {
      for (const n of nodes.values()) {
        if (n.sessionSlug === slug) return n;
      }
      return null;
    },
    byNodeSession(slug: string): DAG | null {
      for (const n of nodes.values()) {
        if (n.sessionSlug === slug) {
          return { ...dag, nodes: Array.from(nodes.values()) };
        }
      }
      return null;
    },
    updateNode(id: string, patch: Partial<DAGNode>): DAGNode {
      const cur = nodes.get(id);
      if (!cur) throw new Error(`node not found: ${id}`);
      const updated = { ...cur, ...patch };
      nodes.set(id, updated);
      patches.push({ id, patch });
      return updated;
    },
  } as unknown as DagRepo;

  return {
    repo,
    patches,
    getNode: (id: string) => nodes.get(id) ?? null,
  };
}

interface MockCtxOptions {
  qualityReport: QualityReport | null;
  parentSession?: Session;
  taskSession?: Session;
  onLand?: (slug: string) => Promise<void> | void;
  openForReviewError?: Error;
  openForReviewResult?: PRSummary | null;
  ciSelfHealMaxAttempts?: number;
}

interface MockCtxResult {
  ctx: EngineContext;
  emitted: ServerEvent[];
  landCalls: { slug: string }[];
  metadataPatches: { slug: string; patch: Record<string, unknown> }[];
  appendedAttention: { slug: string; flag: AttentionFlag }[];
  waitingInputCalls: { slug: string; reason?: string }[];
  audits: { action: string; detail: Record<string, unknown> }[];
  replies: { slug: string; text: string }[];
}

function makeMockCtx(opts: MockCtxOptions): MockCtxResult {
  const emitted: ServerEvent[] = [];
  const landCalls: { slug: string }[] = [];
  const metadataPatches: { slug: string; patch: Record<string, unknown> }[] = [];
  const appendedAttention: { slug: string; flag: AttentionFlag }[] = [];
  const waitingInputCalls: { slug: string; reason?: string }[] = [];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const replies: { slug: string; text: string }[] = [];

  const sessionStore = new Map<string, Session>();
  if (opts.parentSession) sessionStore.set(opts.parentSession.slug, opts.parentSession);
  if (opts.taskSession) sessionStore.set(opts.taskSession.slug, opts.taskSession);

  const ctx = {
    quality: {
      getReport: () => opts.qualityReport,
      runForSession: async () => {
        throw new Error("not used");
      },
    },
    readiness: {
      compute: async (): Promise<never> => {
        throw new Error("readiness.compute must not be called for dag-task sessions");
      },
      summary: () => ({ total: 0, ready: 0, blocked: 0, pending: 0, unknown: 0, bySession: [] }),
    },
    landing: {
      openForReview: async (slug: string) => {
        landCalls.push({ slug });
        if (opts.openForReviewError) throw opts.openForReviewError;
        if (opts.onLand) await opts.onLand(slug);
        return opts.openForReviewResult ?? null;
      },
      retryRebase: async () => {},
    },
    sessions: {
      get: (slug: string) => sessionStore.get(slug) ?? null,
      create: async () => {
        throw new Error("not used");
      },
      setMetadata: (slug: string, patch: Record<string, unknown>) => {
        metadataPatches.push({ slug, patch });
        const cur = sessionStore.get(slug);
        if (cur) {
          sessionStore.set(slug, { ...cur, metadata: { ...cur.metadata, ...patch } });
        }
      },
      appendAttention: (slug: string, flag: AttentionFlag) => {
        appendedAttention.push({ slug, flag });
        const cur = sessionStore.get(slug);
        if (cur) {
          sessionStore.set(slug, { ...cur, attention: [...cur.attention, flag] });
        }
      },
      markWaitingInput: (slug: string, reason?: string) => {
        waitingInputCalls.push({ slug, reason });
        const cur = sessionStore.get(slug);
        if (cur) sessionStore.set(slug, { ...cur, status: "waiting_input" });
      },
      reply: async (slug: string, text: string) => {
        replies.push({ slug, text });
      },
      kickReplyQueue: async () => false,
    },
    runtime: {
      effective: () => ({
        ciSelfHealMaxAttempts: opts.ciSelfHealMaxAttempts,
      }),
    },
    audit: {
      record: (
        _actor: string,
        action: string,
        _target?: { kind: string; id: string },
        detail?: Record<string, unknown>,
      ) => {
        audits.push({ action, detail: detail ?? {} });
      },
    },
    bus: {
      emit: (event: ServerEvent) => {
        emitted.push(event);
      },
    } as unknown as EventBus,
  } as unknown as EngineContext;

  return { ctx, emitted, landCalls, metadataPatches, appendedAttention, waitingInputCalls, audits, replies };
}

function makeStubScheduler(): DagScheduler {
  return {
    tick: async () => {},
  } as unknown as DagScheduler;
}

interface FakeAutomationRepo {
  repo: AutomationJobRepo;
  enqueued: { kind: string; targetId: string | undefined; runAt: string; payload: Record<string, unknown> }[];
}

function makeFakeAutomationRepo(): FakeAutomationRepo {
  const enqueued: FakeAutomationRepo["enqueued"] = [];
  let counter = 0;
  const repo = {
    enqueue: (input: {
      kind: string;
      targetKind?: string;
      targetId?: string;
      payload?: Record<string, unknown>;
      runAt?: string;
    }): AutomationJob => {
      const runAt = input.runAt ?? new Date().toISOString();
      const payload = input.payload ?? {};
      enqueued.push({
        kind: input.kind,
        targetId: input.targetId,
        runAt,
        payload,
      });
      counter += 1;
      return {
        id: `job-${counter}`,
        kind: input.kind,
        targetKind: input.targetKind,
        targetId: input.targetId,
        payload,
        status: "pending",
        attempts: 0,
        maxAttempts: 5,
        nextRunAt: runAt,
        createdAt: runAt,
        updatedAt: runAt,
      };
    },
  } as unknown as AutomationJobRepo;
  return { repo, enqueued };
}

describe("DagTerminalHandler", () => {
  test("missing quality report blocks landing and marks node ci-failed", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, patches, getNode } = makeMockRepo(dag);
    const parent = makeSession("root-1");
    const { ctx, landCalls, appendedAttention } = makeMockCtx({
      qualityReport: null,
      parentSession: parent,
    });

    const handler = new DagTerminalHandler(repo, makeStubScheduler(), ctx, createLogger("error"));
    await handler.handle(makeSession("sess-1"));

    assert.equal(landCalls.length, 0, "land must not be called when quality report missing");
    assert.equal(getNode("n1")?.status, "ci-failed");
    const lastPatch = patches.at(-1);
    assert.equal(lastPatch?.patch.status, "ci-failed");
    assert.match(lastPatch?.patch.failedReason ?? "", /quality report missing/);
    assert.ok(
      appendedAttention.some((a) => a.slug === "root-1" && a.flag.kind === "ci_failed"),
      "should raise ci_failed flag on parent",
    );
  });

  test("dag-task with passed quality lands without invoking PR readiness", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, getNode } = makeMockRepo(dag);
    const { ctx, landCalls } = makeMockCtx({
      qualityReport: {
        sessionSlug: "sess-1",
        status: "passed",
        checks: [],
        createdAt: new Date().toISOString(),
      },
    });

    const handler = new DagTerminalHandler(repo, makeStubScheduler(), ctx, createLogger("error"));
    await handler.handle(makeSession("sess-1"));

    assert.equal(landCalls.length, 1, "openForReview called exactly once");
    assert.equal(landCalls[0]?.slug, "sess-1");
    assert.equal(getNode("n1")?.status, "pr-open");
  });

  test("no configured quality gate (empty configs → passed) lands successfully", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, getNode } = makeMockRepo(dag);
    const { ctx, landCalls } = makeMockCtx({
      qualityReport: {
        sessionSlug: "sess-1",
        status: "passed",
        checks: [],
        createdAt: new Date().toISOString(),
      },
    });

    const handler = new DagTerminalHandler(repo, makeStubScheduler(), ctx, createLogger("error"));
    await handler.handle(makeSession("sess-1"));

    assert.equal(landCalls.length, 1, "openForReview called when no quality gate is configured");
    assert.equal(getNode("n1")?.status, "pr-open");
  });

  test("transitioning a node to pr-open clears stale failedReason from a prior attempt", async () => {
    const node = makeNode("n1", "running", "sess-1");
    node.failedReason = "previous attempt: quality gate failed";
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, getNode, patches } = makeMockRepo(dag);
    const { ctx } = makeMockCtx({
      qualityReport: {
        sessionSlug: "sess-1",
        status: "passed",
        checks: [],
        createdAt: new Date().toISOString(),
      },
    });

    const handler = new DagTerminalHandler(repo, makeStubScheduler(), ctx, createLogger("error"));
    await handler.handle(makeSession("sess-1"));

    assert.equal(getNode("n1")?.status, "pr-open");
    assert.equal(
      getNode("n1")?.failedReason ?? null,
      null,
      "failedReason must be cleared when node transitions to pr-open successfully",
    );
    const landedPatch = patches.find((p) => p.patch.status === "pr-open");
    assert.ok(landedPatch, "expected a patch transitioning the node to pr-open");
    assert.equal(
      landedPatch.patch.failedReason,
      null,
      "the pr-open patch must explicitly set failedReason to null",
    );
  });

  test("dag-task with no commits ahead transitions to pr-open via openForReview returning null", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, getNode } = makeMockRepo(dag);
    const { ctx, landCalls } = makeMockCtx({
      qualityReport: {
        sessionSlug: "sess-1",
        status: "passed",
        checks: [],
        createdAt: new Date().toISOString(),
      },
    });

    const handler = new DagTerminalHandler(repo, makeStubScheduler(), ctx, createLogger("error"));
    await handler.handle(makeSession("sess-1"));

    assert.equal(landCalls.length, 1, "openForReview called once");
    const landed = getNode("n1");
    assert.equal(landed?.status, "pr-open", "node enters pr-open when openForReview returns null");
    assert.equal(landed?.failedReason ?? null, null);
  });

  test("cancelled session maps node to cancelled with no failedReason", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, getNode, patches } = makeMockRepo(dag);
    const { ctx, landCalls } = makeMockCtx({ qualityReport: null });

    const handler = new DagTerminalHandler(repo, makeStubScheduler(), ctx, createLogger("error"));
    await handler.handle(makeSession("sess-1", "cancelled"));

    assert.equal(landCalls.length, 0, "openForReview must not be called for cancelled sessions");
    const after = getNode("n1");
    assert.equal(after?.status, "cancelled");
    assert.equal(after?.failedReason ?? null, null);
    const lastPatch = patches.at(-1);
    assert.equal(lastPatch?.patch.status, "cancelled");
    assert.equal(lastPatch?.patch.failedReason, null);
    assert.ok(lastPatch?.patch.completedAt, "completedAt is recorded");
  });

  test("failed session (non-cancelled) still maps to failed with a reason", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, getNode, patches } = makeMockRepo(dag);
    const { ctx } = makeMockCtx({ qualityReport: null });

    const handler = new DagTerminalHandler(repo, makeStubScheduler(), ctx, createLogger("error"));
    await handler.handle(makeSession("sess-1", "failed"));

    assert.equal(getNode("n1")?.status, "failed");
    assert.match(patches.at(-1)?.patch.failedReason ?? "", /session terminated with status: failed/);
  });

  test("first quality failure self-heals: replies to agent + keeps node running", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, getNode, patches } = makeMockRepo(dag);
    const parent = makeSession("root-1");
    const taskSession = makeSession("sess-1");
    const { ctx, landCalls, replies, metadataPatches, audits } = makeMockCtx({
      qualityReport: {
        sessionSlug: "sess-1",
        status: "failed",
        checks: [
          {
            id: "build",
            name: "build",
            command: "pnpm run build",
            status: "failed",
            exitCode: 2,
            stdoutTail: "error TS2307: Cannot find module 'foo'",
          },
        ],
        createdAt: new Date().toISOString(),
      },
      parentSession: parent,
      taskSession,
    });

    const handler = new DagTerminalHandler(repo, makeStubScheduler(), ctx, createLogger("error"));
    await handler.handle(taskSession);

    assert.equal(landCalls.length, 0, "PR not opened on quality failure");
    assert.equal(getNode("n1")?.status, "running", "node stays running on first quality failure (self-heal)");
    assert.equal(patches.at(-1)?.patch.failedReason, null, "failedReason cleared during self-heal");
    assert.equal(replies.length, 1, "exactly one reply queued to the agent");
    assert.equal(replies[0]?.slug, "sess-1");
    assert.match(replies[0]?.text ?? "", /quality gate failed/i);
    assert.match(replies[0]?.text ?? "", /Cannot find module/);
    const meta = metadataPatches.find((p) => "qualitySelfHealAttempts" in p.patch);
    assert.ok(meta, "metadata patch with qualitySelfHealAttempts exists");
    assert.equal(meta?.patch["qualitySelfHealAttempts"], 1);
    assert.ok(audits.find((a) => a.action === "dag.node.quality_self_heal"), "self-heal audit recorded");
  });

  test("quality self-heal exhaustion (after 2 attempts) flips node ci-failed", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, getNode, patches } = makeMockRepo(dag);
    const parent = makeSession("root-1");
    const taskSession = makeSession("sess-1");
    taskSession.metadata = { qualitySelfHealAttempts: 2 };
    const { ctx, replies } = makeMockCtx({
      qualityReport: {
        sessionSlug: "sess-1",
        status: "failed",
        checks: [],
        createdAt: new Date().toISOString(),
      },
      parentSession: parent,
      taskSession,
    });

    const handler = new DagTerminalHandler(repo, makeStubScheduler(), ctx, createLogger("error"));
    await handler.handle(taskSession);

    assert.equal(getNode("n1")?.status, "ci-failed", "node flipped to ci-failed after exhaustion");
    assert.match(patches.at(-1)?.patch.failedReason ?? "", /quality gate failed.*self-heal attempts/);
    assert.equal(replies.length, 0, "no further reply on exhausted self-heal");
  });

  test("dag-task with passed quality and PR returned enters ci-pending and wires self-heal", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, getNode } = makeMockRepo(dag);
    const taskSession = makeSession("sess-1");
    const pr: PRSummary = {
      number: 42,
      url: "https://github.com/x/y/pull/42",
      state: "open",
      draft: false,
      base: "main",
      head: "minions/sess-1",
      title: "PR for sess-1",
    };
    const { ctx, landCalls, metadataPatches, appendedAttention, waitingInputCalls } = makeMockCtx({
      qualityReport: {
        sessionSlug: "sess-1",
        status: "passed",
        checks: [],
        createdAt: new Date().toISOString(),
      },
      taskSession,
      openForReviewResult: pr,
    });

    const handler = new DagTerminalHandler(repo, makeStubScheduler(), ctx, createLogger("error"));
    await handler.handle(taskSession);

    assert.equal(landCalls.length, 1, "openForReview was called");
    assert.equal(getNode("n1")?.status, "ci-pending", "node enters ci-pending, not landed");
    assert.equal(getNode("n1")?.completedAt, undefined, "completedAt is not set for ci-pending");

    const metaPatch = metadataPatches.find(
      (p) => p.slug === "sess-1" && p.patch["selfHealCi"] === true,
    );
    assert.ok(metaPatch, "selfHealCi metadata is set");
    assert.equal(metaPatch.patch["ciSelfHealAttempts"], 0, "ciSelfHealAttempts seeded to 0");

    const ciPending = appendedAttention.find(
      (a) => a.slug === "sess-1" && a.flag.kind === "ci_pending",
    );
    assert.ok(ciPending, "ci_pending attention appended to dag-task session");

    assert.equal(waitingInputCalls.length, 1, "session marked waiting_input");
    assert.equal(waitingInputCalls[0]?.slug, "sess-1");
  });

  test("dag-task with ciSelfHealConcluded=success skips ci-pending and lands directly", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, getNode } = makeMockRepo(dag);
    const taskSession = makeSession("sess-1");
    taskSession.metadata = { ciSelfHealConcluded: "success" };
    const pr: PRSummary = {
      number: 42,
      url: "https://github.com/x/y/pull/42",
      state: "open",
      draft: false,
      base: "main",
      head: "minions/sess-1",
      title: "PR for sess-1",
    };
    const { ctx, metadataPatches, appendedAttention, waitingInputCalls } = makeMockCtx({
      qualityReport: {
        sessionSlug: "sess-1",
        status: "passed",
        checks: [],
        createdAt: new Date().toISOString(),
      },
      taskSession,
      openForReviewResult: pr,
    });

    const handler = new DagTerminalHandler(repo, makeStubScheduler(), ctx, createLogger("error"));
    await handler.handle(taskSession);

    assert.equal(getNode("n1")?.status, "pr-open", "node enters pr-open when CI already concluded success");
    assert.equal(metadataPatches.length, 0, "no self-heal metadata wiring on success re-entry");
    assert.equal(appendedAttention.length, 0, "no ci_pending attention on success re-entry");
    assert.equal(waitingInputCalls.length, 0, "no waiting_input transition on success re-entry");
  });

  test("dag-task with ciSelfHealConcluded=exhausted marks node ci-failed", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, getNode, patches } = makeMockRepo(dag);
    const parent = makeSession("root-1");
    const taskSession = makeSession("sess-1");
    taskSession.metadata = { ciSelfHealConcluded: "exhausted" };
    const pr: PRSummary = {
      number: 42,
      url: "https://github.com/x/y/pull/42",
      state: "open",
      draft: false,
      base: "main",
      head: "minions/sess-1",
      title: "PR for sess-1",
    };
    const { ctx, appendedAttention } = makeMockCtx({
      qualityReport: {
        sessionSlug: "sess-1",
        status: "passed",
        checks: [],
        createdAt: new Date().toISOString(),
      },
      taskSession,
      parentSession: parent,
      openForReviewResult: pr,
    });

    const handler = new DagTerminalHandler(repo, makeStubScheduler(), ctx, createLogger("error"));
    await handler.handle(taskSession);

    assert.equal(getNode("n1")?.status, "ci-failed");
    assert.match(patches.at(-1)?.patch.failedReason ?? "", /self-heal exhausted/);
    assert.ok(
      appendedAttention.some((a) => a.slug === "root-1" && a.flag.kind === "ci_failed"),
      "ci_failed flag raised on parent",
    );
  });

  test("transient push error leaves node running, enqueues delayed dag-tick, no failed cascade", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, getNode, patches } = makeMockRepo(dag);
    const taskSession = makeSession("sess-1");
    const transientErr = new EngineError(
      "transient_push_error",
      "transient push error for branch: ECONNRESET",
      { branch: "minions/sess-1" },
    );
    const { ctx, audits } = makeMockCtx({
      qualityReport: {
        sessionSlug: "sess-1",
        status: "passed",
        checks: [],
        createdAt: new Date().toISOString(),
      },
      taskSession,
      openForReviewError: transientErr,
    });
    const { repo: automationRepo, enqueued } = makeFakeAutomationRepo();

    const handler = new DagTerminalHandler(
      repo,
      makeStubScheduler(),
      ctx,
      createLogger("error"),
      automationRepo,
    );
    await handler.handle(taskSession);

    const after = getNode("n1");
    assert.equal(after?.status, "running", "node stays running after transient push error");
    assert.equal(after?.failedReason, undefined, "no failedReason for transient push error");
    assert.ok(
      !patches.some((p) => p.patch.status === "failed"),
      "node never marked failed for transient push error",
    );

    const ticks = enqueued.filter((j) => j.kind === "dag-tick" && j.targetId === "dag-1");
    assert.equal(ticks.length, 1, "dag-tick enqueued for retry");
    const delayMs = new Date(ticks[0]!.runAt).getTime() - Date.now();
    assert.ok(delayMs > 55_000 && delayMs < 65_000, `expected ~60s delay, got ${delayMs}ms`);

    const transientAudits = audits.filter((a) => a.action === "dag.node.transient_push_retry");
    assert.equal(transientAudits.length, 1, "transient retry audit recorded");
  });

  test("transient github error (rate limit during PR creation) reschedules with retryAfterMs", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, getNode } = makeMockRepo(dag);
    const taskSession = makeSession("sess-1");
    const ghErr = new EngineError(
      "transient_github_error",
      "GitHub API rate limited (status 403); retry after ~120s",
      { url: "https://api.github.com/repos/x/y/pulls", status: 403, retryAfterMs: 120_000 },
    );
    const { ctx, audits } = makeMockCtx({
      qualityReport: {
        sessionSlug: "sess-1",
        status: "passed",
        checks: [],
        createdAt: new Date().toISOString(),
      },
      taskSession,
      openForReviewError: ghErr,
    });
    const { repo: automationRepo, enqueued } = makeFakeAutomationRepo();

    const handler = new DagTerminalHandler(
      repo,
      makeStubScheduler(),
      ctx,
      createLogger("error"),
      automationRepo,
    );
    await handler.handle(taskSession);

    const after = getNode("n1");
    assert.equal(after?.status, "running", "node stays running on github rate limit");

    const ticks = enqueued.filter((j) => j.kind === "dag-tick" && j.targetId === "dag-1");
    assert.equal(ticks.length, 1);
    const delayMs = new Date(ticks[0]!.runAt).getTime() - Date.now();
    assert.ok(
      delayMs > 115_000 && delayMs < 125_000,
      `expected ~120s delay from retryAfterMs, got ${delayMs}ms`,
    );

    const ghAudits = audits.filter((a) => a.action === "dag.node.transient_github_retry");
    assert.equal(ghAudits.length, 1, "transient github retry audit recorded");
  });

  test("dag-task with maxAttempts=0 lands directly without wiring self-heal", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, getNode } = makeMockRepo(dag);
    const taskSession = makeSession("sess-1");
    const pr: PRSummary = {
      number: 42,
      url: "https://github.com/x/y/pull/42",
      state: "open",
      draft: false,
      base: "main",
      head: "minions/sess-1",
      title: "PR for sess-1",
    };
    const { ctx, metadataPatches, appendedAttention, waitingInputCalls } = makeMockCtx({
      qualityReport: {
        sessionSlug: "sess-1",
        status: "passed",
        checks: [],
        createdAt: new Date().toISOString(),
      },
      taskSession,
      openForReviewResult: pr,
      ciSelfHealMaxAttempts: 0,
    });

    const handler = new DagTerminalHandler(repo, makeStubScheduler(), ctx, createLogger("error"));
    await handler.handle(taskSession);

    assert.equal(getNode("n1")?.status, "pr-open", "node enters pr-open when self-heal disabled");
    assert.equal(metadataPatches.length, 0, "no self-heal metadata when maxAttempts=0");
    assert.equal(appendedAttention.length, 0, "no ci_pending attention when maxAttempts=0");
    assert.equal(waitingInputCalls.length, 0, "no waiting_input transition when maxAttempts=0");
  });
});

function makeTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

function insertTestSession(db: Database.Database, slug: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sessions(
      slug, title, prompt, mode, status, attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens,
      stats_cache_read_tokens, stats_cache_creation_tokens,
      stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, created_at, updated_at, pr_draft, metadata
    ) VALUES (?, ?, ?, 'task', 'running', '[]', '[]', 0, 0, 0, 0, 0, 0, 0, 0, 'mock', ?, ?, 0, '{}')
  `).run(slug, "test title", "test prompt", now, now);
}

describe("ci_failed attention persists across restart", () => {
  test("raiseCiFailed writes ci_failed flag to SQLite and survives a new SessionRepo", async () => {
    const db = makeTestDb();
    const parentSlug = "root-ci-persist";
    const taskSlug = "task-ci-persist";
    const nodeId = "node-persist-1";

    insertTestSession(db, parentSlug);
    insertTestSession(db, taskSlug);

    const sessionRepo = new SessionRepo(db);
    let parentSession = sessionRepo.get(parentSlug)!;
    const taskSession = makeSession(taskSlug);

    const node = makeNode(nodeId, "running", taskSlug);
    const dag = makeDag("dag-persist", [node], parentSlug);
    const { repo } = makeMockRepo(dag);

    const { ctx } = makeMockCtx({
      qualityReport: null,
      parentSession,
    });

    (ctx.sessions as unknown as { appendAttention: (slug: string, flag: AttentionFlag) => void }).appendAttention = (slug, flag) => {
      const current = sessionRepo.get(slug);
      if (!current) return;
      sessionRepo.setAttention(slug, [...current.attention, flag]);
      if (slug === parentSlug) parentSession = sessionRepo.get(slug)!;
    };

    (ctx.sessions as unknown as { get: (slug: string) => Session | null }).get = (slug) => {
      if (slug === parentSlug) return parentSession;
      if (slug === taskSlug) return taskSession;
      return null;
    };

    const handler = new DagTerminalHandler(repo, makeStubScheduler(), ctx, createLogger("error"));
    await handler.handle(taskSession);

    const freshRepo = new SessionRepo(db);
    const persisted = freshRepo.get(parentSlug);
    assert.ok(persisted, "parent session must exist after restart");
    const flag = persisted!.attention.find((a) => a.kind === "ci_failed");
    assert.ok(flag, "ci_failed attention flag must be persisted in SQLite");
    assert.match(flag!.message, new RegExp(nodeId));

    db.close();
  });
});
