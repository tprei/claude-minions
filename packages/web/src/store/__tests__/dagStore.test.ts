import { describe, it, expect, beforeEach } from "vitest";
import type { DAG, DAGNode, DagNodeCiSummary } from "@minions/shared";
import { useDagStore } from "../dagStore.js";

const CONN = "conn-1";

function makeNode(id: string, overrides: Partial<DAGNode> = {}): DAGNode {
  return {
    id,
    title: id,
    prompt: `do ${id}`,
    status: "pending",
    dependsOn: [],
    metadata: {},
    ...overrides,
  };
}

function makeDag(id: string, nodes: DAGNode[]): DAG {
  const now = "2026-04-30T00:00:00.000Z";
  return {
    id,
    title: "t",
    goal: "g",
    nodes,
    createdAt: now,
    updatedAt: now,
    status: "active",
    metadata: {},
  };
}

describe("useDagStore.upsertNode", () => {
  beforeEach(() => {
    useDagStore.setState({ byConnection: new Map() });
  });

  it("patches a node in place when present", () => {
    const dag = makeDag("dag1", [makeNode("a"), makeNode("b")]);
    useDagStore.getState().replaceAll(CONN, [dag]);

    const summary: DagNodeCiSummary = {
      state: "failing",
      counts: { passed: 0, failed: 1, pending: 0 },
      checks: [{ name: "test", bucket: "fail" }],
      prNumber: 7,
      prUrl: "https://x.test/pull/7",
      updatedAt: "2026-04-30T01:00:00.000Z",
    };

    const updated = makeNode("b", { ciSummary: summary });
    useDagStore.getState().upsertNode(CONN, "dag1", updated);

    const stored = useDagStore.getState().byConnection.get(CONN)?.get("dag1");
    expect(stored).toBeDefined();
    expect(stored?.nodes.length).toBe(2);
    expect(stored?.nodes[0]?.ciSummary ?? null).toBeNull();
    expect(stored?.nodes[1]?.ciSummary).toEqual(summary);
  });

  it("is a no-op when the dag is unknown", () => {
    useDagStore.getState().upsertNode(CONN, "missing", makeNode("a"));
    const slice = useDagStore.getState().byConnection.get(CONN);
    expect(slice?.get("missing")).toBeUndefined();
  });

  it("is a no-op when the node id is not in the dag", () => {
    const dag = makeDag("dag1", [makeNode("a")]);
    useDagStore.getState().replaceAll(CONN, [dag]);
    useDagStore.getState().upsertNode(CONN, "dag1", makeNode("z"));
    const stored = useDagStore.getState().byConnection.get(CONN)?.get("dag1");
    expect(stored?.nodes.map((n) => n.id)).toEqual(["a"]);
  });
});
