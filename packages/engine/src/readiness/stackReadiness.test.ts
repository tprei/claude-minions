import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type {
  AttentionFlag,
  DAG,
  DAGNode,
  PRSummary,
  QualityReport,
  Session,
} from "@minions/shared";
import { computeStackReadiness, type StackReadinessDeps } from "./stackReadiness.js";

function makeSession(
  slug: string,
  overrides: Partial<Session> = {},
): Session {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    slug,
    title: slug,
    prompt: "p",
    mode: "task",
    status: "running",
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
    createdAt: now,
    updatedAt: now,
    childSlugs: [],
    metadata: {},
    ...overrides,
  };
}

function flag(kind: AttentionFlag["kind"]): AttentionFlag {
  return { kind, message: kind, raisedAt: "2026-01-01T00:00:00.000Z" };
}

const openPr: PRSummary = {
  number: 1,
  url: "https://example.test/pr/1",
  state: "open",
  draft: false,
  base: "main",
  head: "feature",
  title: "feat",
};

function makeNode(
  id: string,
  sessionSlug: string | undefined,
  status: DAGNode["status"] = "merged",
): DAGNode {
  return {
    id,
    title: `node ${id}`,
    prompt: `do ${id}`,
    status,
    dependsOn: [],
    sessionSlug,
    metadata: {},
  };
}

function makeDag(rootSessionSlug: string, nodes: DAGNode[]): DAG {
  return {
    id: "dag-1",
    title: "test dag",
    goal: "ship X",
    rootSessionSlug,
    nodes,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    metadata: {},
  };
}

function makeDeps(args: {
  parentSlug: string;
  dag: DAG | null;
  childSessions: Session[];
  qualityReports?: Map<string, QualityReport>;
}): StackReadinessDeps {
  const sessions = new Map<string, Session>();
  const parent = makeSession(args.parentSlug, { mode: "ship", shipStage: "verify" });
  sessions.set(args.parentSlug, parent);
  for (const cs of args.childSessions) sessions.set(cs.slug, cs);

  return {
    getSession: (slug) => sessions.get(slug) ?? null,
    findDagByRootSession: (slug) =>
      args.dag && args.dag.rootSessionSlug === slug ? args.dag : null,
    getQualityReport: (slug) => args.qualityReports?.get(slug) ?? null,
  };
}

describe("computeStackReadiness", () => {
  test("ready when all DAG nodes are merged", () => {
    const parentSlug = "ship-parent";
    const childA = makeSession("child-a", { pr: openPr, attention: [flag("ci_passed")] });
    const childB = makeSession("child-b", {
      pr: { ...openPr, number: 2, url: "https://example.test/pr/2" },
      attention: [flag("ci_passed")],
    });
    const dag = makeDag(parentSlug, [
      makeNode("n1", "child-a", "merged"),
      makeNode("n2", "child-b", "merged"),
    ]);

    const deps = makeDeps({
      parentSlug,
      dag,
      childSessions: [childA, childB],
    });

    const result = computeStackReadiness(parentSlug, deps);

    assert.equal(result.status, "ready");
    assert.equal(result.sessionSlug, parentSlug);
    const stack = result.checks.find((c) => c.id === "stack");
    assert.equal(stack?.status, "ok");
    const nodeChecks = result.checks.filter((c) => c.id.startsWith("node:"));
    assert.equal(nodeChecks.length, 2);
    assert.ok(nodeChecks.every((c) => c.status === "ok"));
  });

  test("ready when all DAG nodes are landed (legacy alias)", () => {
    const parentSlug = "ship-parent";
    const childA = makeSession("child-a", { pr: openPr, attention: [flag("ci_passed")] });
    const dag = makeDag(parentSlug, [makeNode("n1", "child-a", "landed")]);

    const deps = makeDeps({
      parentSlug,
      dag,
      childSessions: [childA],
    });

    const result = computeStackReadiness(parentSlug, deps);
    assert.equal(result.status, "ready");
  });

  test("pending when a node is pr-open but not merged", () => {
    const parentSlug = "ship-parent";
    const childA = makeSession("child-a", { pr: openPr, attention: [flag("ci_passed")] });
    const childB = makeSession("child-b", {
      pr: { ...openPr, number: 2, url: "https://example.test/pr/2" },
      attention: [flag("ci_passed")],
    });
    const dag = makeDag(parentSlug, [
      makeNode("n1", "child-a", "merged"),
      makeNode("n2", "child-b", "pr-open"),
    ]);
    dag.nodes[1]!.title = "awaiting-merge-node";

    const deps = makeDeps({
      parentSlug,
      dag,
      childSessions: [childA, childB],
    });

    const result = computeStackReadiness(parentSlug, deps);

    assert.equal(result.status, "pending");
    const stack = result.checks.find((c) => c.id === "stack");
    assert.equal(stack?.status, "pending");
    assert.match(stack?.detail ?? "", /awaiting-merge-node/);
    assert.match(stack?.detail ?? "", /not merged/i);
  });

  test("pending when one node's child session has no PR; detail names the failing node", () => {
    const parentSlug = "ship-parent";
    const childA = makeSession("child-a", { pr: openPr, attention: [flag("ci_passed")] });
    const childB = makeSession("child-b", { attention: [flag("ci_passed")] });
    const dag = makeDag(parentSlug, [
      makeNode("n1", "child-a", "merged"),
      makeNode("n2", "child-b", "running"),
    ]);
    dag.nodes[1]!.title = "missing-pr-node";

    const deps = makeDeps({
      parentSlug,
      dag,
      childSessions: [childA, childB],
    });

    const result = computeStackReadiness(parentSlug, deps);

    assert.equal(result.status, "pending");
    const stack = result.checks.find((c) => c.id === "stack");
    assert.equal(stack?.status, "pending");
    assert.match(stack?.detail ?? "", /missing-pr-node/);
    assert.match(stack?.detail ?? "", /no PR/i);
  });

  test("pending when one node has ci_failed attention", () => {
    const parentSlug = "ship-parent";
    const childA = makeSession("child-a", { pr: openPr, attention: [flag("ci_passed")] });
    const childB = makeSession("child-b", {
      pr: { ...openPr, number: 2, url: "https://example.test/pr/2" },
      attention: [flag("ci_failed")],
    });
    const dag = makeDag(parentSlug, [
      makeNode("n1", "child-a", "merged"),
      makeNode("n2", "child-b", "running"),
    ]);
    dag.nodes[1]!.title = "ci-fail-node";

    const deps = makeDeps({
      parentSlug,
      dag,
      childSessions: [childA, childB],
    });

    const result = computeStackReadiness(parentSlug, deps);

    assert.equal(result.status, "pending");
    const stack = result.checks.find((c) => c.id === "stack");
    assert.equal(stack?.status, "pending");
    assert.match(stack?.detail ?? "", /ci-fail-node/);
    assert.match(stack?.detail ?? "", /CI failed/i);
    const failingNodeCheck = result.checks.find((c) => c.id === "node:n2");
    assert.equal(failingNodeCheck?.status, "pending");
  });

  test("pending when ship session has no DAG bound", () => {
    const parentSlug = "ship-parent";
    const deps = makeDeps({ parentSlug, dag: null, childSessions: [] });
    const result = computeStackReadiness(parentSlug, deps);
    assert.equal(result.status, "pending");
    assert.match(result.checks[0]?.detail ?? "", /no DAG bound/);
  });

  test("unknown when session is not in ship mode", () => {
    const sessions = new Map<string, Session>();
    sessions.set("regular", makeSession("regular", { mode: "task" }));
    const deps: StackReadinessDeps = {
      getSession: (s) => sessions.get(s) ?? null,
      findDagByRootSession: () => null,
      getQualityReport: () => null,
    };
    const result = computeStackReadiness("regular", deps);
    assert.equal(result.status, "unknown");
  });

  test("pending when child's quality report failed", () => {
    const parentSlug = "ship-parent";
    const childA = makeSession("child-a", { pr: openPr, attention: [flag("ci_passed")] });
    const dag = makeDag(parentSlug, [makeNode("n1", "child-a", "running")]);
    const quality = new Map<string, QualityReport>([
      [
        "child-a",
        {
          sessionSlug: "child-a",
          status: "failed",
          checks: [],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    ]);

    const deps = makeDeps({
      parentSlug,
      dag,
      childSessions: [childA],
      qualityReports: quality,
    });

    const result = computeStackReadiness(parentSlug, deps);
    assert.equal(result.status, "pending");
    assert.match(result.checks[0]?.detail ?? "", /quality failed/);
  });
});
