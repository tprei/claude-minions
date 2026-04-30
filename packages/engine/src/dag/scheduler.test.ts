import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { DAG, DAGNode, Session } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { EventBus } from "../bus/eventBus.js";
import { DagScheduler } from "./scheduler.js";
import { DagRepo } from "./model.js";
import { createLogger } from "../logger.js";
import { EngineError } from "../errors.js";

function makeNode(
  id: string,
  status: DAGNode["status"],
  dependsOn: string[] = [],
): DAGNode {
  return {
    id,
    title: id,
    prompt: `do ${id}`,
    status,
    dependsOn,
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

interface MockDagRepo {
  dags: Map<string, DAG>;
  nodes: Map<string, DAGNode>;
  get: (id: string) => DAG | null;
  list: () => DAG[];
  update: (id: string, patch: Partial<DAG>) => DAG;
  getNode: (id: string) => DAGNode | null;
  getNodeBySession: (slug: string) => DAGNode | null;
  updateNode: (id: string, patch: Partial<DAGNode>) => DAGNode;
  byNodeSession: (slug: string) => DAG | null;
  listNodes: (dagId: string) => DAGNode[];
}

function makeMockRepo(dag: DAG): MockDagRepo {
  const dags = new Map<string, DAG>([[dag.id, dag]]);
  const nodes = new Map<string, DAGNode>(dag.nodes.map((n) => [n.id, n]));

  const repo: MockDagRepo = {
    dags,
    nodes,
    get(id: string): DAG | null {
      const d = dags.get(id);
      if (!d) return null;
      return { ...d, nodes: Array.from(nodes.values()).filter((n) => d.nodes.some((dn) => dn.id === n.id)) };
    },
    list(): DAG[] {
      return Array.from(dags.values()).map((d) => ({
        ...d,
        nodes: Array.from(nodes.values()).filter((n) => d.nodes.some((dn) => dn.id === n.id)),
      }));
    },
    update(id: string, patch: Partial<DAG>): DAG {
      const current = dags.get(id);
      if (!current) throw new Error(`not found: ${id}`);
      const updated = { ...current, ...patch };
      dags.set(id, updated);
      return updated;
    },
    getNode(id: string): DAGNode | null {
      return nodes.get(id) ?? null;
    },
    getNodeBySession(slug: string): DAGNode | null {
      for (const n of nodes.values()) {
        if (n.sessionSlug === slug) return n;
      }
      return null;
    },
    updateNode(id: string, patch: Partial<DAGNode>): DAGNode {
      const current = nodes.get(id);
      if (!current) throw new Error(`node not found: ${id}`);
      const updated = { ...current, ...patch };
      nodes.set(id, updated);
      const dag = Array.from(dags.values()).find((d) => d.nodes.some((n) => n.id === id));
      if (dag) {
        dags.set(dag.id, { ...dag, nodes: Array.from(nodes.values()).filter((n) => dag.nodes.some((dn) => dn.id === n.id)) });
      }
      return updated;
    },
    byNodeSession(slug: string): DAG | null {
      for (const n of nodes.values()) {
        if (n.sessionSlug === slug) {
          const d = Array.from(dags.values()).find((d) => d.nodes.some((dn) => dn.id === n.id));
          return d ?? null;
        }
      }
      return null;
    },
    listNodes(dagId: string): DAGNode[] {
      const d = dags.get(dagId);
      if (!d) return [];
      return d.nodes.map((dn) => nodes.get(dn.id) ?? dn);
    },
  };

  return repo;
}

function makeMockCtx(spawnedSessions: Session[]): EngineContext {
  let sessionCounter = 0;

  return {
    sessions: {
      create: async (req) => {
        const slug = `mock-session-${++sessionCounter}`;
        const session: Session = {
          slug,
          title: req.title ?? slug,
          prompt: req.prompt,
          mode: req.mode ?? "task",
          status: "running",
          attention: [],
          quickActions: [],
          branch: `minions/${slug}`,
          baseBranch: req.baseBranch,
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
          metadata: (req.metadata ?? {}) as Record<string, unknown>,
        };
        spawnedSessions.push(session);
        return session;
      },
      get: (slug: string) => spawnedSessions.find((s) => s.slug === slug) ?? null,
      list: () => [],
      listPaged: () => ({ items: [] }),
      listWithTranscript: () => [],
      transcript: () => [],
      stop: async () => {},
      close: async () => {},
      delete: async () => {},
      reply: async () => {},
      setDagId: () => {},
      markWaitingInput: () => {},
      appendAttention: () => {},
      dismissAttention: () => { throw new Error("not implemented"); },
      kickReplyQueue: async () => false,
      resumeAllActive: async () => {},
      diff: async (slug) => ({ sessionSlug: slug, patch: "", stats: [], truncated: false, byteSize: 0, generatedAt: new Date().toISOString() }),
      screenshots: async () => [],
      screenshotPath: () => "",
      checkpoints: () => [],
      restoreCheckpoint: async () => {},
      updateBucket: () => {},
    },
    runtime: {
      schema: () => ({ groups: [], fields: [] }),
      values: () => ({}),
      effective: () => ({}),
      update: async () => {},
    },
    dags: {} as EngineContext["dags"],
    ship: {} as EngineContext["ship"],
    landing: {} as EngineContext["landing"],
    loops: {} as EngineContext["loops"],
    variants: {} as EngineContext["variants"],
    ci: {} as EngineContext["ci"],
    quality: {} as EngineContext["quality"],
    readiness: {} as EngineContext["readiness"],
    intake: {} as EngineContext["intake"],
    memory: {} as EngineContext["memory"],
    audit: {} as EngineContext["audit"],
    resource: {} as EngineContext["resource"],
    push: {} as EngineContext["push"],
    digest: {} as EngineContext["digest"],
    github: {} as EngineContext["github"],
    stats: {} as EngineContext["stats"],
    cleanup: {} as EngineContext["cleanup"],
    bus: {} as EventBus,
    mutex: {} as EngineContext["mutex"],
    env: {} as EngineContext["env"],
    log: createLogger("error"),
    db: {} as EngineContext["db"],
    workspaceDir: "/tmp",
    features: () => [],
    featuresPending: () => [],
    repos: () => [],
    getRepo: () => null,
    shutdown: async () => {},
  };
}

describe("DagScheduler", () => {
  test("tick spawns B when A is done", async () => {
    const nodeA = makeNode("A", "done");
    const nodeB = makeNode("B", "pending", ["A"]);
    const nodeC = makeNode("C", "pending", ["B"]);

    const dag = makeDag("dag1", [nodeA, nodeB, nodeC]);
    const repo = makeMockRepo(dag) as unknown as DagRepo;
    const spawnedSessions: Session[] = [];
    const ctx = makeMockCtx(spawnedSessions);

    const scheduler = new DagScheduler(repo, ctx, createLogger("error"));

    await scheduler.tick("dag1");

    assert.equal(spawnedSessions.length, 1, "exactly one session spawned (for B)");
    assert.equal(spawnedSessions[0]?.mode, "dag-task");

    const bNode = repo.getNode("B");
    assert.equal(bNode?.status, "running", "B should be running");
    assert.ok(bNode?.sessionSlug, "B should have a session slug");

    const cNode = repo.getNode("C");
    assert.equal(cNode?.status, "pending", "C should still be pending");
  });

  test("tick spawns C when B is marked done", async () => {
    const nodeA = makeNode("A", "done");
    const nodeB = makeNode("B", "pending", ["A"]);
    const nodeC = makeNode("C", "pending", ["B"]);

    const dag = makeDag("dag1", [nodeA, nodeB, nodeC]);
    const repo = makeMockRepo(dag) as unknown as DagRepo;
    const spawnedSessions: Session[] = [];
    const ctx = makeMockCtx(spawnedSessions);

    const scheduler = new DagScheduler(repo, ctx, createLogger("error"));

    await scheduler.tick("dag1");

    assert.equal(spawnedSessions.length, 1, "B spawned after first tick");

    repo.updateNode("B", { status: "done" });

    spawnedSessions.length = 0;

    await scheduler.tick("dag1");

    assert.equal(spawnedSessions.length, 1, "C spawned after second tick");
    const cNode = repo.getNode("C");
    assert.equal(cNode?.status, "running", "C should be running");
  });

  test("tick respects concurrency cap", async () => {
    const nodeA = makeNode("A", "done");
    const nodeB = makeNode("B", "pending");
    const nodeC = makeNode("C", "pending");
    const nodeD = makeNode("D", "pending");
    const nodeE = makeNode("E", "pending");

    const dag = makeDag("dag1", [nodeA, nodeB, nodeC, nodeD, nodeE]);
    const repo = makeMockRepo(dag) as unknown as DagRepo;
    const spawnedSessions: Session[] = [];
    const ctx = makeMockCtx(spawnedSessions);

    const scheduler = new DagScheduler(repo, ctx, createLogger("error"));

    await scheduler.tick("dag1");

    assert.equal(spawnedSessions.length, 3, "at most 3 sessions spawned (default cap)");
  });

  for (const terminal of ["ci-failed", "rebase-conflict", "cancelled"] as const) {
    test(`checkCompletion advances DAG to failed when a node ends in ${terminal}`, async () => {
      const nodeA = makeNode("A", "landed");
      const nodeB = makeNode("B", terminal);

      const dag = makeDag("dag1", [nodeA, nodeB]);
      const repo = makeMockRepo(dag) as unknown as DagRepo;
      const spawnedSessions: Session[] = [];
      const ctx = makeMockCtx(spawnedSessions);

      const scheduler = new DagScheduler(repo, ctx, createLogger("error"));

      await scheduler.tick("dag1");

      assert.equal(spawnedSessions.length, 0, "no new sessions spawned");
      const finalDag = repo.get("dag1");
      assert.equal(finalDag?.status, "failed", `DAG should be failed when node is ${terminal}`);
    });
  }

  test("checkCompletion marks DAG completed when every node is landed", async () => {
    const nodeA = makeNode("A", "landed");
    const nodeB = makeNode("B", "landed", ["A"]);
    const nodeC = makeNode("C", "landed", ["B"]);

    const dag = makeDag("dag1", [nodeA, nodeB, nodeC]);
    const repo = makeMockRepo(dag) as unknown as DagRepo;
    const spawnedSessions: Session[] = [];
    const ctx = makeMockCtx(spawnedSessions);

    const scheduler = new DagScheduler(repo, ctx, createLogger("error"));

    await scheduler.tick("dag1");

    assert.equal(spawnedSessions.length, 0, "no new sessions spawned for an all-landed DAG");
    const finalDag = repo.get("dag1");
    assert.equal(finalDag?.status, "completed", "all-landed DAG must aggregate to completed");
  });

  test("checkCompletion marks DAG completed for a mix of landed and done success-terminal nodes", async () => {
    const nodeA = makeNode("A", "done");
    const nodeB = makeNode("B", "landed", ["A"]);
    const nodeC = makeNode("C", "skipped", ["B"]);

    const dag = makeDag("dag1", [nodeA, nodeB, nodeC]);
    const repo = makeMockRepo(dag) as unknown as DagRepo;
    const spawnedSessions: Session[] = [];
    const ctx = makeMockCtx(spawnedSessions);

    const scheduler = new DagScheduler(repo, ctx, createLogger("error"));

    await scheduler.tick("dag1");

    const finalDag = repo.get("dag1");
    assert.equal(
      finalDag?.status,
      "completed",
      "DAG must be completed when every node is in a success-terminal state",
    );
  });

  test("admission-denied EngineError keeps node pending and bumps admissionRetries", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const nodeA = makeNode("A", "pending");
    const dag = makeDag("dag1", [nodeA]);
    const repo = makeMockRepo(dag) as unknown as DagRepo;
    const ctx = makeMockCtx([]);

    let createCalls = 0;
    ctx.sessions.create = async () => {
      createCalls++;
      throw new EngineError(
        "conflict",
        "Admission denied: dag_task 4 at dagCap 4",
        { class: "dag_task" },
      );
    };

    const scheduler = new DagScheduler(repo, ctx, createLogger("error"));
    await scheduler.tick("dag1");

    assert.equal(createCalls, 1);
    const node = repo.getNode("A");
    assert.equal(node?.status, "pending", "node remains pending after admission denial");
    assert.ok(
      node?.failedReason === undefined || node?.failedReason === null,
      "no failed reason set",
    );
    assert.equal(
      (node?.metadata as { admissionRetries?: number }).admissionRetries,
      1,
      "admissionRetries bumped to 1",
    );

    const finalDag = repo.get("dag1");
    assert.equal(finalDag?.status, "active", "dag stays active");
  });

  test("admission-denied schedules a re-tick after backoff", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const nodeA = makeNode("A", "pending");
    const dag = makeDag("dag1", [nodeA]);
    const repo = makeMockRepo(dag) as unknown as DagRepo;
    const ctx = makeMockCtx([]);

    let createCalls = 0;
    ctx.sessions.create = async () => {
      createCalls++;
      throw new EngineError(
        "conflict",
        "Admission denied: dag_task 4 at dagCap 4",
        {},
      );
    };

    const scheduler = new DagScheduler(repo, ctx, createLogger("error"));
    await scheduler.tick("dag1");
    assert.equal(createCalls, 1);

    t.mock.timers.tick(30_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    assert.ok(createCalls >= 2, `expected re-tick after 30s; createCalls=${createCalls}`);
  });

  test("admission-denied escalates to failed after MAX_ADMISSION_RETRIES", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const nodeA = makeNode("A", "pending");
    nodeA.metadata = { admissionRetries: 59 };

    const dag = makeDag("dag1", [nodeA]);
    const repo = makeMockRepo(dag) as unknown as DagRepo;
    const ctx = makeMockCtx([]);

    ctx.sessions.create = async () => {
      throw new EngineError(
        "conflict",
        "Admission denied: dag_task 4 at dagCap 4",
        {},
      );
    };

    const scheduler = new DagScheduler(repo, ctx, createLogger("error"));
    await scheduler.tick("dag1");

    const node = repo.getNode("A");
    assert.equal(node?.status, "failed", "node escalates to failed after cap");
    assert.match(
      node?.failedReason ?? "",
      /admission denied 60 times/,
      "failure reason cites the retry count",
    );
    assert.match(
      node?.failedReason ?? "",
      /slot pressure too high/,
      "failure reason cites slot pressure",
    );
  });

  test("non-admission spawn errors still mark the node failed", async () => {
    const nodeA = makeNode("A", "pending");
    const dag = makeDag("dag1", [nodeA]);
    const repo = makeMockRepo(dag) as unknown as DagRepo;
    const ctx = makeMockCtx([]);

    ctx.sessions.create = async () => {
      throw new Error("network blew up");
    };

    const scheduler = new DagScheduler(repo, ctx, createLogger("error"));
    await scheduler.tick("dag1");

    const node = repo.getNode("A");
    assert.equal(node?.status, "failed");
    assert.equal(node?.failedReason, "network blew up");
    assert.equal(
      (node?.metadata as { admissionRetries?: number }).admissionRetries,
      undefined,
      "non-admission errors do not touch admissionRetries",
    );
  });

  test("stacked PRs: A bases on dag.baseBranch, B (depends on A) bases on A's session branch", async () => {
    const nodeA = makeNode("A", "pending");
    const nodeB = makeNode("B", "pending", ["A"]);

    const dag = makeDag("dag1", [nodeA, nodeB]);
    dag.baseBranch = "main";

    const repo = makeMockRepo(dag) as unknown as DagRepo;
    const spawnedSessions: Session[] = [];
    const ctx = makeMockCtx(spawnedSessions);

    const scheduler = new DagScheduler(repo, ctx, createLogger("error"));

    await scheduler.tick("dag1");

    assert.equal(spawnedSessions.length, 1, "only A spawns first");
    const aSession = spawnedSessions[0];
    assert.ok(aSession, "A session exists");
    assert.equal(aSession.baseBranch, "main", "root node A bases on dag.baseBranch (main)");

    const aNode = repo.getNode("A");
    assert.equal(aNode?.sessionSlug, aSession.slug, "A node points at its session");

    repo.updateNode("A", { status: "done" });

    await scheduler.tick("dag1");

    assert.equal(spawnedSessions.length, 2, "B spawns after A done");
    const bSession = spawnedSessions[1];
    assert.ok(bSession, "B session exists");
    assert.equal(
      bSession.baseBranch,
      aSession.branch,
      "B bases on A's session branch (stacked PR), not main",
    );
    assert.equal(
      bSession.baseBranch,
      `minions/${aSession.slug}`,
      "B's base matches the minions/<A-slug> branch convention",
    );
  });
});
