import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { DAG, DAGNode } from "@minions/shared";
import type { EngineContext } from "../context.js";
import { DagMergedHandler } from "./onMerged.js";
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

function makeDag(id: string, nodes: DAGNode[]): DAG {
  const now = new Date().toISOString();
  return {
    id,
    title: "test dag",
    goal: "test goal",
    nodes,
    createdAt: now,
    updatedAt: now,
    status: "active",
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

interface AuditCall {
  actor: string;
  action: string;
  target?: { kind: string; id: string };
  detail?: Record<string, unknown>;
}

function makeMockCtx(): { ctx: EngineContext; audit: AuditCall[] } {
  const audit: AuditCall[] = [];
  const ctx = {
    audit: {
      record: (
        actor: string,
        action: string,
        target?: { kind: string; id: string },
        detail?: Record<string, unknown>,
      ) => {
        audit.push({ actor, action, target, detail });
      },
    },
  } as unknown as EngineContext;
  return { ctx, audit };
}

function makeStubScheduler(): { scheduler: DagScheduler; ticks: string[] } {
  const ticks: string[] = [];
  const scheduler = {
    tick: async (id?: string) => {
      ticks.push(id ?? "");
    },
  } as unknown as DagScheduler;
  return { scheduler, ticks };
}

describe("DagMergedHandler", () => {
  test("flips pr-open node to merged on PR merge event", async () => {
    const node = makeNode("n1", "pr-open", "sess-1");
    const dag = makeDag("dag-1", [node]);
    const { repo, getNode } = makeMockRepo(dag);
    const { ctx, audit } = makeMockCtx();
    const { scheduler, ticks } = makeStubScheduler();

    const handler = new DagMergedHandler(repo, scheduler, ctx, createLogger("error"));
    await handler.handle("sess-1");

    assert.equal(getNode("n1")?.status, "merged");
    assert.deepEqual(ticks, ["dag-1"]);
    const mergedAudit = audit.find((a) => a.action === "dag.node.merged");
    assert.ok(mergedAudit, "merge audit recorded");
    assert.equal(mergedAudit?.detail?.["from"], "pr-open");
  });

  test("flips legacy landed node to merged on PR merge event", async () => {
    const node = makeNode("n1", "landed", "sess-1");
    const dag = makeDag("dag-1", [node]);
    const { repo, getNode } = makeMockRepo(dag);
    const { ctx } = makeMockCtx();
    const { scheduler } = makeStubScheduler();

    const handler = new DagMergedHandler(repo, scheduler, ctx, createLogger("error"));
    await handler.handle("sess-1");

    assert.equal(getNode("n1")?.status, "merged");
  });

  test("no-op when session is not bound to a DAG node", async () => {
    const node = makeNode("n1", "pr-open", "sess-1");
    const dag = makeDag("dag-1", [node]);
    const { repo, getNode, patches } = makeMockRepo(dag);
    const { ctx } = makeMockCtx();
    const { scheduler, ticks } = makeStubScheduler();

    const handler = new DagMergedHandler(repo, scheduler, ctx, createLogger("error"));
    await handler.handle("unknown-slug");

    assert.equal(getNode("n1")?.status, "pr-open", "node unchanged");
    assert.equal(patches.length, 0);
    assert.equal(ticks.length, 0);
  });

  test("no-op when node is in a non-pr-open status", async () => {
    const node = makeNode("n1", "running", "sess-1");
    const dag = makeDag("dag-1", [node]);
    const { repo, getNode, patches } = makeMockRepo(dag);
    const { ctx } = makeMockCtx();
    const { scheduler, ticks } = makeStubScheduler();

    const handler = new DagMergedHandler(repo, scheduler, ctx, createLogger("error"));
    await handler.handle("sess-1");

    assert.equal(getNode("n1")?.status, "running");
    assert.equal(patches.length, 0);
    assert.equal(ticks.length, 0);
  });
});
