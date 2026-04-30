import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type {
  DAG,
  DAGNode,
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
  onLand?: (slug: string) => Promise<void> | void;
  openForReviewError?: Error;
}

interface MockCtxResult {
  ctx: EngineContext;
  emitted: ServerEvent[];
  landCalls: { slug: string }[];
}

function makeMockCtx(opts: MockCtxOptions): MockCtxResult {
  const emitted: ServerEvent[] = [];
  const landCalls: { slug: string }[] = [];

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
        return null;
      },
      retryRebase: async () => {},
    },
    sessions: {
      get: (slug: string) => (opts.parentSession && opts.parentSession.slug === slug ? opts.parentSession : null),
      create: async () => {
        throw new Error("not used");
      },
    },
    bus: {
      emit: (event: ServerEvent) => {
        emitted.push(event);
      },
    } as unknown as EventBus,
  } as unknown as EngineContext;

  return { ctx, emitted, landCalls };
}

function makeStubScheduler(): DagScheduler {
  return {
    tick: async () => {},
  } as unknown as DagScheduler;
}

describe("DagTerminalHandler", () => {
  test("missing quality report blocks landing and marks node ci-failed", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, patches, getNode } = makeMockRepo(dag);
    const parent = makeSession("root-1");
    const { ctx, landCalls, emitted } = makeMockCtx({
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
    assert.ok(emitted.some((e) => e.kind === "session_updated"), "should raise ci_failed flag on parent");
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
    assert.equal(getNode("n1")?.status, "landed");
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
    assert.equal(getNode("n1")?.status, "landed");
  });

  test("transitioning a node to landed clears stale failedReason from a prior attempt", async () => {
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

    assert.equal(getNode("n1")?.status, "landed");
    assert.equal(
      getNode("n1")?.failedReason ?? null,
      null,
      "failedReason must be cleared when node lands successfully",
    );
    const landedPatch = patches.find((p) => p.patch.status === "landed");
    assert.ok(landedPatch, "expected a patch transitioning the node to landed");
    assert.equal(
      landedPatch.patch.failedReason,
      null,
      "the landed patch must explicitly set failedReason to null",
    );
  });

  test("dag-task with no commits ahead transitions to landed via openForReview returning null", async () => {
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
    assert.equal(landed?.status, "landed", "node lands when openForReview returns null");
    assert.equal(landed?.failedReason ?? null, null);
  });

  test("failed quality report blocks landing", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node], "root-1");
    const { repo, getNode, patches } = makeMockRepo(dag);
    const parent = makeSession("root-1");
    const { ctx, landCalls } = makeMockCtx({
      qualityReport: {
        sessionSlug: "sess-1",
        status: "failed",
        checks: [],
        createdAt: new Date().toISOString(),
      },
      parentSession: parent,
    });

    const handler = new DagTerminalHandler(repo, makeStubScheduler(), ctx, createLogger("error"));
    await handler.handle(makeSession("sess-1"));

    assert.equal(landCalls.length, 0);
    assert.equal(getNode("n1")?.status, "ci-failed");
    assert.match(patches.at(-1)?.patch.failedReason ?? "", /quality gate failed/);
  });
});
