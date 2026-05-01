import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { DAG, DAGNode, Session } from "@minions/shared";
import type { EngineContext } from "../context.js";
import { resolveWorkstream } from "./resolveWorkstream.js";

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

function buildNode(overrides: Partial<DAGNode> & Pick<DAGNode, "id" | "title">): DAGNode {
  return {
    prompt: "node prompt",
    status: "pending",
    dependsOn: [],
    metadata: {},
    ...overrides,
  };
}

function buildDag(overrides: Partial<DAG> & Pick<DAG, "id" | "nodes">): DAG {
  return {
    title: "ship title from dag",
    goal: "ship goal",
    rootSessionSlug: "ship-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active",
    metadata: {},
    ...overrides,
  };
}

interface Harness {
  ctx: EngineContext;
  dags: Map<string, DAG>;
  sessions: Map<string, Session>;
}

function makeHarness(opts: { dags?: DAG[]; sessions?: Session[] } = {}): Harness {
  const dags = new Map<string, DAG>();
  for (const d of opts.dags ?? []) dags.set(d.id, d);
  const sessions = new Map<string, Session>();
  for (const s of opts.sessions ?? []) sessions.set(s.slug, s);

  const ctx = {
    dags: {
      get: (id: string) => dags.get(id) ?? null,
    },
    sessions: {
      get: (slug: string) => sessions.get(slug) ?? null,
    },
  } as unknown as EngineContext;

  return { ctx, dags, sessions };
}

describe("resolveWorkstream", () => {
  test("returns null for ship session", () => {
    const session = buildSession("ship-1", { mode: "ship" });
    const h = makeHarness();
    assert.equal(resolveWorkstream(h.ctx, session), null);
  });

  test("returns null for plain task session", () => {
    const session = buildSession("worker", { mode: "task" });
    const h = makeHarness();
    assert.equal(resolveWorkstream(h.ctx, session), null);
  });

  test("returns null for dag-task with no dagId", () => {
    const session = buildSession("worker", { mode: "dag-task" });
    const h = makeHarness();
    assert.equal(resolveWorkstream(h.ctx, session), null);
  });

  test("happy path: 3-node dag where deps have PRs", () => {
    const node1 = buildNode({
      id: "n1",
      title: "first",
      pr: { number: 100, url: "u100" },
    });
    const node2 = buildNode({
      id: "n2",
      title: "second",
      dependsOn: ["n1"],
      pr: { number: 101, url: "u101" },
    });
    const node3 = buildNode({
      id: "n3",
      title: "third",
      dependsOn: ["n1", "n2"],
    });
    const dag = buildDag({
      id: "dag-1",
      title: "fallback ship title",
      rootSessionSlug: "ship-1",
      nodes: [node1, node2, node3],
    });
    const ship = buildSession("ship-1", { mode: "ship", title: "Real Ship Title" });
    const dagSession = buildSession("worker", {
      mode: "dag-task",
      dagId: "dag-1",
      dagNodeId: "n3",
    });
    const h = makeHarness({ dags: [dag], sessions: [ship] });

    const info = resolveWorkstream(h.ctx, dagSession);
    assert.ok(info, "expected non-null workstream info");
    assert.equal(info!.rootShipSlug, "ship-1");
    assert.equal(info!.rootShipTitle, "Real Ship Title");
    assert.equal(info!.nodeIndex, 3);
    assert.equal(info!.nodeTotal, 3);
    assert.equal(info!.nodeTitle, "third");
    assert.deepEqual(info!.dependsOnPrs, [100, 101]);
    assert.equal(info!.stacksOnPr, 100);
  });

  test("ship session not loadable falls back to dag.title", () => {
    const node1 = buildNode({ id: "n1", title: "first" });
    const dag = buildDag({
      id: "dag-1",
      title: "fallback dag title",
      rootSessionSlug: "missing-ship",
      nodes: [node1],
    });
    const dagSession = buildSession("worker", {
      mode: "dag-task",
      dagId: "dag-1",
      dagNodeId: "n1",
    });
    const h = makeHarness({ dags: [dag] });

    const info = resolveWorkstream(h.ctx, dagSession);
    assert.ok(info);
    assert.equal(info!.rootShipTitle, "fallback dag title");
  });

  test("node with empty dependsOn yields stacksOnPr null and empty dependsOnPrs", () => {
    const node1 = buildNode({ id: "n1", title: "first" });
    const dag = buildDag({ id: "dag-1", nodes: [node1] });
    const ship = buildSession("ship-1", { mode: "ship", title: "Ship" });
    const dagSession = buildSession("worker", {
      mode: "dag-task",
      dagId: "dag-1",
      dagNodeId: "n1",
    });
    const h = makeHarness({ dags: [dag], sessions: [ship] });

    const info = resolveWorkstream(h.ctx, dagSession);
    assert.ok(info);
    assert.deepEqual(info!.dependsOnPrs, []);
    assert.equal(info!.stacksOnPr, null);
    assert.equal(info!.nodeIndex, 1);
    assert.equal(info!.nodeTotal, 1);
  });

  test("first dep without a PR drops it from dependsOnPrs and yields stacksOnPr null", () => {
    const node1 = buildNode({ id: "n1", title: "first" });
    const node2 = buildNode({
      id: "n2",
      title: "second",
      pr: { number: 200, url: "u200" },
    });
    const node3 = buildNode({
      id: "n3",
      title: "third",
      dependsOn: ["n1", "n2"],
    });
    const dag = buildDag({ id: "dag-1", nodes: [node1, node2, node3] });
    const ship = buildSession("ship-1", { mode: "ship", title: "Ship" });
    const dagSession = buildSession("worker", {
      mode: "dag-task",
      dagId: "dag-1",
      dagNodeId: "n3",
    });
    const h = makeHarness({ dags: [dag], sessions: [ship] });

    const info = resolveWorkstream(h.ctx, dagSession);
    assert.ok(info);
    assert.deepEqual(info!.dependsOnPrs, [200]);
    assert.equal(info!.stacksOnPr, null);
  });

  test("falls back to metadata.dagNodeId when session.dagNodeId is missing", () => {
    const node1 = buildNode({ id: "n1", title: "first" });
    const node2 = buildNode({ id: "n2", title: "second", dependsOn: ["n1"] });
    const dag = buildDag({ id: "dag-1", nodes: [node1, node2] });
    const ship = buildSession("ship-1", { mode: "ship", title: "Ship" });
    const dagSession = buildSession("worker", {
      mode: "dag-task",
      dagId: "dag-1",
      metadata: { dagNodeId: "n2" },
    });
    const h = makeHarness({ dags: [dag], sessions: [ship] });

    const info = resolveWorkstream(h.ctx, dagSession);
    assert.ok(info);
    assert.equal(info!.nodeTitle, "second");
    assert.equal(info!.nodeIndex, 2);
    assert.equal(info!.nodeTotal, 2);
  });
});
