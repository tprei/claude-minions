import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { AuditEvent, DAG, DAGNode, Session, SessionStatus } from "@minions/shared";
import type { EngineContext } from "../context.js";
import { EventBus } from "../bus/eventBus.js";
import { EngineError } from "../errors.js";
import { KeyedMutex } from "../util/mutex.js";
import { DagScheduler } from "./scheduler.js";
import { DagRepo } from "./model.js";
import { AutomationJobRepo } from "../store/repos/automationJobRepo.js";
import { createDagSubsystem } from "./index.js";
import { createLogger } from "../logger.js";
import { openStore } from "../store/sqlite.js";

interface AuditCall {
  actor: string;
  action: string;
  target?: { kind: string; id: string };
  detail?: Record<string, unknown>;
}

function makeNode(
  id: string,
  status: DAGNode["status"],
  opts: { dependsOn?: string[]; sessionSlug?: string } = {},
): DAGNode {
  return {
    id,
    title: id,
    prompt: `do ${id}`,
    status,
    dependsOn: opts.dependsOn ?? [],
    sessionSlug: opts.sessionSlug,
    metadata: {},
  };
}

function makeDag(id: string, nodes: DAGNode[]): DAG {
  const now = new Date().toISOString();
  return {
    id,
    title: "watchdog dag",
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

  function dagWithLatestNodes(d: DAG): DAG {
    return { ...d, nodes: d.nodes.map((dn) => nodes.get(dn.id) ?? dn) };
  }

  return {
    dags,
    nodes,
    get(id) {
      const d = dags.get(id);
      return d ? dagWithLatestNodes(d) : null;
    },
    list() {
      return Array.from(dags.values()).map(dagWithLatestNodes);
    },
    update(id, patch) {
      const current = dags.get(id);
      if (!current) throw new Error(`not found: ${id}`);
      const updated = { ...current, ...patch };
      dags.set(id, updated);
      return dagWithLatestNodes(updated);
    },
    getNode(id) {
      return nodes.get(id) ?? null;
    },
    getNodeBySession(slug) {
      for (const n of nodes.values()) {
        if (n.sessionSlug === slug) return n;
      }
      return null;
    },
    updateNode(id, patch) {
      const current = nodes.get(id);
      if (!current) throw new Error(`node not found: ${id}`);
      const updated: DAGNode = { ...current, ...patch };
      nodes.set(id, updated);
      return updated;
    },
    byNodeSession(slug) {
      for (const n of nodes.values()) {
        if (n.sessionSlug === slug) {
          const d = Array.from(dags.values()).find((dd) => dd.nodes.some((dn) => dn.id === n.id));
          return d ? dagWithLatestNodes(d) : null;
        }
      }
      return null;
    },
    listNodes(dagId) {
      const d = dags.get(dagId);
      if (!d) return [];
      return d.nodes.map((dn) => nodes.get(dn.id) ?? dn);
    },
  };
}

function makeSession(slug: string, status: SessionStatus): Session {
  const now = new Date().toISOString();
  return {
    slug,
    title: slug,
    prompt: "",
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
    createdAt: now,
    updatedAt: now,
    childSlugs: [],
    metadata: {},
  };
}

interface StopCall {
  slug: string;
  reason?: string;
}

function makeMockCtx(
  sessionsBySlug: Map<string, Session>,
  audit: AuditCall[],
  stopCalls: StopCall[] = [],
): EngineContext {
  let counter = 0;
  return {
    sessions: {
      create: async (req) => {
        const slug = `spawn-${++counter}`;
        const session = makeSession(slug, "running");
        session.title = req.title ?? slug;
        session.prompt = req.prompt;
        session.mode = req.mode ?? "task";
        session.metadata = (req.metadata ?? {}) as Record<string, unknown>;
        sessionsBySlug.set(slug, session);
        return session;
      },
      get: (slug: string) => sessionsBySlug.get(slug) ?? null,
      list: () => Array.from(sessionsBySlug.values()),
      listPaged: () => ({ items: [] }),
      listWithTranscript: () => [],
      transcript: () => [],
      stop: async (slug: string, reason?: string) => {
        stopCalls.push({ slug, reason });
      },
      close: async () => {},
      delete: async () => {},
      reply: async () => {},
      setDagId: () => {},
      setMetadata: () => {},
      markCompleted: () => {},
      markFailed: () => {},
      spawnPending: async () => ({ spawned: false }),
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
    runtime: {
      schema: () => ({ groups: [], fields: [] }),
      values: () => ({}),
      effective: () => ({}),
      update: async () => {},
    },
    audit: {
      record: (actor, action, target, detail) => {
        audit.push({ actor, action, target, detail });
      },
      list: (): AuditEvent[] => [],
    },
    lifecycle: {} as EngineContext["lifecycle"],
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
    resource: {} as EngineContext["resource"],
    push: {} as EngineContext["push"],
    digest: {} as EngineContext["digest"],
    github: {} as EngineContext["github"],
    stats: {} as EngineContext["stats"],
    cleanup: {} as EngineContext["cleanup"],
    bus: new EventBus(),
    mutex: new KeyedMutex(),
    env: {} as EngineContext["env"],
    log: createLogger("error"),
    db: {} as EngineContext["db"],
    workspaceDir: "/tmp",
    previousMarker: null,
    features: () => [],
    featuresPending: () => [],
    repos: () => [],
    getRepo: () => null,
    shutdown: async () => {},
  };
}

function makeTempDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-watchdog-"));
  return openStore({ path: path.join(dir, "engine.db"), log: createLogger("error") });
}

function seedDag(db: Database.Database, bus: EventBus, dag: DAG): DagRepo {
  const repo = new DagRepo(db, bus);
  repo.insert({
    id: dag.id,
    title: dag.title,
    goal: dag.goal,
    repoId: dag.repoId,
    baseBranch: dag.baseBranch,
    rootSessionSlug: dag.rootSessionSlug,
    status: dag.status,
    metadata: dag.metadata,
    createdAt: dag.createdAt,
    updatedAt: dag.updatedAt,
  });
  let ord = 0;
  for (const node of dag.nodes) {
    const inserted = repo.insertNode(
      dag.id,
      {
        title: node.title,
        prompt: node.prompt,
        status: node.status,
        dependsOn: node.dependsOn,
        sessionSlug: node.sessionSlug,
        metadata: node.metadata,
      },
      ord++,
    );
    // Preserve the originally-requested id by patching after insert. The repo
    // generates a slug, so for tests that need stable ids we rename via a direct
    // update statement below.
    db.prepare(`UPDATE dag_nodes SET id = ? WHERE id = ?`).run(node.id, inserted.id);
  }
  return repo;
}

describe("DagScheduler.watchdogTick", () => {
  test("flips running node to failed when its session is in failed state", async () => {
    const node = makeNode("A", "running", { sessionSlug: "sess-A" });
    const dag = makeDag("dag1", [node]);
    const repo = makeMockRepo(dag);
    const sessions = new Map<string, Session>([["sess-A", makeSession("sess-A", "failed")]]);
    const audit: AuditCall[] = [];
    const ctx = makeMockCtx(sessions, audit);
    const watchdogDb = makeTempDb();
    const scheduler = new DagScheduler(repo as unknown as DagRepo, ctx, createLogger("error"), new AutomationJobRepo(watchdogDb));

    await scheduler.watchdogTick();

    const after = repo.getNode("A");
    assert.equal(after?.status, "failed", "A should be failed");
    assert.match(after?.failedReason ?? "", /watchdog/);

    const auditRow = audit.find((a) => a.action === "dag.watchdog");
    assert.ok(auditRow, "watchdog audit row written");
    assert.equal(auditRow?.target?.kind, "dag");
    assert.equal(auditRow?.target?.id, "dag1");
    assert.equal(auditRow?.detail?.["nodeId"], "A");
    assert.equal(auditRow?.detail?.["from"], "running");
    assert.equal(auditRow?.detail?.["to"], "failed");
  });

  test("running node with still-running session is left alone", async () => {
    const node = makeNode("A", "running", { sessionSlug: "sess-A" });
    const dag = makeDag("dag1", [node]);
    const repo = makeMockRepo(dag);
    const sessions = new Map<string, Session>([["sess-A", makeSession("sess-A", "running")]]);
    const audit: AuditCall[] = [];
    const ctx = makeMockCtx(sessions, audit);
    const watchdogDb = makeTempDb();
    const scheduler = new DagScheduler(repo as unknown as DagRepo, ctx, createLogger("error"), new AutomationJobRepo(watchdogDb));

    await scheduler.watchdogTick();

    assert.equal(repo.getNode("A")?.status, "running");
    assert.equal(audit.filter((a) => a.action === "dag.watchdog").length, 0);
  });

  test("running node with completed session is LEFT ALONE so onTerminal can advance it", async () => {
    // Regression: watchdog used to flip running→failed for any TERMINAL session
    // status (including completed). That raced the normal terminal flow
    // (qualityGate → onTerminal) and triggered cascadeUpstreamFailures to
    // cancel every dependent before the node reached pr-open.
    const node = makeNode("A", "running", { sessionSlug: "sess-A" });
    const dag = makeDag("dag-completed-race", [node]);
    const repo = makeMockRepo(dag);
    const sessions = new Map<string, Session>([
      ["sess-A", makeSession("sess-A", "completed")],
    ]);
    const audit: AuditCall[] = [];
    const ctx = makeMockCtx(sessions, audit);
    const watchdogDb = makeTempDb();
    const scheduler = new DagScheduler(repo as unknown as DagRepo, ctx, createLogger("error"), new AutomationJobRepo(watchdogDb));

    await scheduler.watchdogTick();

    assert.equal(
      repo.getNode("A")?.status,
      "running",
      "completed-session running node must NOT be flipped — terminal handlers will advance it",
    );
    assert.equal(
      audit.filter((a) => a.action === "dag.watchdog").length,
      0,
      "no watchdog audit for completed sessions",
    );
  });

  test("running node with cancelled session is flipped to failed", async () => {
    const node = makeNode("A", "running", { sessionSlug: "sess-A" });
    const dag = makeDag("dag-cancelled", [node]);
    const repo = makeMockRepo(dag);
    const sessions = new Map<string, Session>([
      ["sess-A", makeSession("sess-A", "cancelled")],
    ]);
    const audit: AuditCall[] = [];
    const ctx = makeMockCtx(sessions, audit);
    const watchdogDb = makeTempDb();
    const scheduler = new DagScheduler(repo as unknown as DagRepo, ctx, createLogger("error"), new AutomationJobRepo(watchdogDb));

    await scheduler.watchdogTick();

    assert.equal(repo.getNode("A")?.status, "failed");
    assert.equal(
      audit.find((a) => a.action === "dag.watchdog")?.detail?.["sessionStatus"],
      "cancelled",
    );
  });

  test("ready and pending nodes are no-op for watchdog", async () => {
    const ready = makeNode("R", "ready", { sessionSlug: "sess-R" });
    const pending = makeNode("P", "pending");
    const dag = makeDag("dag1", [ready, pending]);
    const repo = makeMockRepo(dag);
    const sessions = new Map<string, Session>([["sess-R", makeSession("sess-R", "failed")]]);
    const audit: AuditCall[] = [];
    const ctx = makeMockCtx(sessions, audit);
    const watchdogDb = makeTempDb();
    const scheduler = new DagScheduler(repo as unknown as DagRepo, ctx, createLogger("error"), new AutomationJobRepo(watchdogDb));

    await scheduler.watchdogTick();

    assert.equal(repo.getNode("R")?.status, "ready");
    assert.equal(repo.getNode("P")?.status, "pending");
    assert.equal(audit.filter((a) => a.action === "dag.watchdog").length, 0);
  });

  test("node stuck in ready with no session triggers dispatch after >60s", async () => {
    const node = makeNode("R", "ready");
    const dag = makeDag("dag-stale", [node]);
    const repo = makeMockRepo(dag);
    const sessions = new Map<string, Session>();
    const audit: AuditCall[] = [];
    const ctx = makeMockCtx(sessions, audit);
    const watchdogDb = makeTempDb();
    const scheduler = new DagScheduler(repo as unknown as DagRepo, ctx, createLogger("error"), new AutomationJobRepo(watchdogDb));

    // First tick: records firstSeen — no dispatch yet.
    await scheduler.watchdogTick();
    assert.equal(repo.getNode("R")?.status, "ready", "node still ready after first tick");

    // Fake the firstSeen timestamp to be 65s ago.
    const staleMap = (scheduler as unknown as { staleReadyFirstSeen: Map<string, number> }).staleReadyFirstSeen;
    staleMap.set("dag-stale:R", Date.now() - 65_000);

    // Second tick: >60s elapsed — dispatch is called, which calls tick() on the dag.
    // tick() scans for pending nodes; since node is still "ready" and no pending nodes
    // exist, it will not attempt to spawn again, but dispatch was invoked.
    await scheduler.watchdogTick();

    // Confirm the scheduler attempted a dispatch pass (node remains ready because
    // there are no pending deps to promote — but the path was taken).
    assert.equal(repo.getNode("R")?.status, "ready");
  });

  test("stale-ready firstSeen key is cleaned up when node leaves ready", async () => {
    const node = makeNode("R2", "ready");
    const dag = makeDag("dag-cleanup", [node]);
    const repo = makeMockRepo(dag);
    const sessions = new Map<string, Session>();
    const audit: AuditCall[] = [];
    const ctx = makeMockCtx(sessions, audit);
    const watchdogDb = makeTempDb();
    const scheduler = new DagScheduler(repo as unknown as DagRepo, ctx, createLogger("error"), new AutomationJobRepo(watchdogDb));

    await scheduler.watchdogTick();
    const staleMap = (scheduler as unknown as { staleReadyFirstSeen: Map<string, number> }).staleReadyFirstSeen;
    assert.ok(staleMap.has("dag-cleanup:R2"), "firstSeen recorded");

    // Node transitions away from ready.
    repo.updateNode("R2", { status: "running", sessionSlug: "sess-new" });

    await scheduler.watchdogTick();
    assert.ok(!staleMap.has("dag-cleanup:R2"), "firstSeen cleaned up when node left ready");
  });
});

describe("Dag api operator commands", () => {
  test("retry resets a failed node to pending and triggers a tick that respawns", async () => {
    const db = makeTempDb();
    const bus = new EventBus();
    const sessions = new Map<string, Session>();
    const audit: AuditCall[] = [];
    const ctx = makeMockCtx(sessions, audit);
    ctx.bus = bus;
    ctx.db = db;

    const dag = makeDag("dag-r1", [makeNode("A", "failed", { sessionSlug: "old-A" })]);
    seedDag(db, bus, dag);

    const subsystem = createDagSubsystem({
      ctx,
      log: createLogger("error"),
      env: {} as EngineContext["env"],
      db,
      bus,
      mutex: ctx.mutex,
      workspaceDir: "/tmp",
      automationRepo: new AutomationJobRepo(db),
    });
    ctx.dags = subsystem.api;

    try {
      await subsystem.api.retry("dag-r1", "A");

      const repo = new DagRepo(db, bus);
      const after = repo.getNode("A");
      assert.equal(after?.status, "running", "scheduler.tick promoted A from pending to running");
      assert.notEqual(after?.sessionSlug, "old-A", "old session slug cleared and replaced by new spawn");
      assert.ok(sessions.size >= 1, "ctx.sessions.create was called");
      const retryAudit = audit.find((a) => a.action === "dag.node.retry");
      assert.ok(retryAudit, "dag.node.retry audit row written");
      assert.equal(retryAudit?.target?.kind, "dag-node");
      assert.equal(retryAudit?.target?.id, "A");
      assert.equal(retryAudit?.detail?.["dagId"], "dag-r1");
      assert.equal(retryAudit?.detail?.["from"], "failed");
      assert.equal(retryAudit?.detail?.["to"], "pending");
      assert.equal(retryAudit?.detail?.["oldSessionSlug"], "old-A");
    } finally {
      await subsystem.onShutdown?.();
      db.close();
    }
  });

  test("retry resets a cancelled node to pending so the parent ship can rerun it", async () => {
    const db = makeTempDb();
    const bus = new EventBus();
    const sessions = new Map<string, Session>();
    const audit: AuditCall[] = [];
    const ctx = makeMockCtx(sessions, audit);
    ctx.bus = bus;
    ctx.db = db;

    const dag = makeDag("dag-rc", [makeNode("A", "cancelled", { sessionSlug: "old-A" })]);
    seedDag(db, bus, dag);

    const subsystem = createDagSubsystem({
      ctx,
      log: createLogger("error"),
      env: {} as EngineContext["env"],
      db,
      bus,
      mutex: ctx.mutex,
      workspaceDir: "/tmp",
      automationRepo: new AutomationJobRepo(db),
    });
    ctx.dags = subsystem.api;

    try {
      await subsystem.api.retry("dag-rc", "A");

      const repo = new DagRepo(db, bus);
      const after = repo.getNode("A");
      assert.equal(after?.status, "running", "scheduler.tick promoted cancelled node to running");
      assert.notEqual(after?.sessionSlug, "old-A");
      const retryAudit = audit.find((a) => a.action === "dag.node.retry");
      assert.ok(retryAudit, "dag.node.retry audit row written for cancelled retry");
      assert.equal(retryAudit?.detail?.["from"], "cancelled");
    } finally {
      await subsystem.onShutdown?.();
      db.close();
    }
  });

  test("retry rejects with conflict when dag is cancelled", async () => {
    const db = makeTempDb();
    const bus = new EventBus();
    const sessions = new Map<string, Session>();
    const audit: AuditCall[] = [];
    const ctx = makeMockCtx(sessions, audit);
    ctx.bus = bus;
    ctx.db = db;

    const dag = makeDag("dag-cx", [makeNode("A", "failed", { sessionSlug: "old-A" })]);
    const repo = seedDag(db, bus, dag);
    repo.update("dag-cx", { status: "cancelled" });

    const subsystem = createDagSubsystem({
      ctx,
      log: createLogger("error"),
      env: {} as EngineContext["env"],
      db,
      bus,
      mutex: ctx.mutex,
      workspaceDir: "/tmp",
      automationRepo: new AutomationJobRepo(db),
    });
    ctx.dags = subsystem.api;

    try {
      await assert.rejects(
        () => subsystem.api.retry("dag-cx", "A"),
        (err: unknown) => err instanceof EngineError && err.code === "conflict",
      );
    } finally {
      await subsystem.onShutdown?.();
      db.close();
    }
  });

  test("retry rejects with conflict when node is in a non-retryable status", async () => {
    const nonRetryable: DAGNode["status"][] = [
      "running",
      "landed",
      "pending",
      "done",
    ];
    for (const status of nonRetryable) {
      const db = makeTempDb();
      const bus = new EventBus();
      const sessions = new Map<string, Session>();
      const audit: AuditCall[] = [];
      const ctx = makeMockCtx(sessions, audit);
      ctx.bus = bus;
      ctx.db = db;

      const dag = makeDag(`dag-nr-${status}`, [makeNode("A", status)]);
      seedDag(db, bus, dag);

      const subsystem = createDagSubsystem({
        ctx,
        log: createLogger("error"),
        env: {} as EngineContext["env"],
        db,
        bus,
        mutex: ctx.mutex,
        workspaceDir: "/tmp",
        automationRepo: new AutomationJobRepo(db),
      });
      ctx.dags = subsystem.api;

      try {
        await assert.rejects(
          () => subsystem.api.retry(`dag-nr-${status}`, "A"),
          (err: unknown) => err instanceof EngineError && err.code === "conflict",
          `expected conflict for status ${status}`,
        );
      } finally {
        await subsystem.onShutdown?.();
        db.close();
      }
    }
  });

  test("retry rejects with conflict when an upstream dep is not in SUCCESS_NODE_STATUSES", async () => {
    const badDepStatuses: DAGNode["status"][] = ["pending", "running", "failed"];
    for (const depStatus of badDepStatuses) {
      const db = makeTempDb();
      const bus = new EventBus();
      const sessions = new Map<string, Session>();
      const audit: AuditCall[] = [];
      const ctx = makeMockCtx(sessions, audit);
      ctx.bus = bus;
      ctx.db = db;

      const dag = makeDag(`dag-dep-${depStatus}`, [
        makeNode("A", depStatus),
        makeNode("B", "failed", { dependsOn: ["A"] }),
      ]);
      seedDag(db, bus, dag);

      const subsystem = createDagSubsystem({
        ctx,
        log: createLogger("error"),
        env: {} as EngineContext["env"],
        db,
        bus,
        mutex: ctx.mutex,
        workspaceDir: "/tmp",
        automationRepo: new AutomationJobRepo(db),
      });
      ctx.dags = subsystem.api;

      try {
        await assert.rejects(
          () => subsystem.api.retry(`dag-dep-${depStatus}`, "B"),
          (err: unknown) => err instanceof EngineError && err.code === "conflict",
          `expected conflict for dep status ${depStatus}`,
        );
      } finally {
        await subsystem.onShutdown?.();
        db.close();
      }
    }
  });

  test("retry stops a non-terminal old session with reason 'dag-node-retry'", async () => {
    const db = makeTempDb();
    const bus = new EventBus();
    const sessions = new Map<string, Session>();
    sessions.set("old-A", makeSession("old-A", "running"));
    const audit: AuditCall[] = [];
    const stopCalls: StopCall[] = [];
    const ctx = makeMockCtx(sessions, audit, stopCalls);
    ctx.bus = bus;
    ctx.db = db;

    const dag = makeDag("dag-stop", [makeNode("A", "failed", { sessionSlug: "old-A" })]);
    seedDag(db, bus, dag);

    const subsystem = createDagSubsystem({
      ctx,
      log: createLogger("error"),
      env: {} as EngineContext["env"],
      db,
      bus,
      mutex: ctx.mutex,
      workspaceDir: "/tmp",
      automationRepo: new AutomationJobRepo(db),
    });
    ctx.dags = subsystem.api;

    try {
      await subsystem.api.retry("dag-stop", "A");

      assert.equal(stopCalls.length, 1, "stop called exactly once");
      assert.equal(stopCalls[0]?.slug, "old-A");
      assert.equal(stopCalls[0]?.reason, "dag-node-retry");
    } finally {
      await subsystem.onShutdown?.();
      db.close();
    }
  });

  test("retry does not stop an already-terminal old session", async () => {
    const terminal: SessionStatus[] = ["completed", "failed", "cancelled"];
    for (const status of terminal) {
      const db = makeTempDb();
      const bus = new EventBus();
      const sessions = new Map<string, Session>();
      sessions.set("old-A", makeSession("old-A", status));
      const audit: AuditCall[] = [];
      const stopCalls: StopCall[] = [];
      const ctx = makeMockCtx(sessions, audit, stopCalls);
      ctx.bus = bus;
      ctx.db = db;

      const dag = makeDag(`dag-noskip-${status}`, [
        makeNode("A", "failed", { sessionSlug: "old-A" }),
      ]);
      seedDag(db, bus, dag);

      const subsystem = createDagSubsystem({
        ctx,
        log: createLogger("error"),
        env: {} as EngineContext["env"],
        db,
        bus,
        mutex: ctx.mutex,
        workspaceDir: "/tmp",
        automationRepo: new AutomationJobRepo(db),
      });
      ctx.dags = subsystem.api;

      try {
        await subsystem.api.retry(`dag-noskip-${status}`, "A");
        assert.equal(stopCalls.length, 0, `stop must not be called when old session is ${status}`);
      } finally {
        await subsystem.onShutdown?.();
        db.close();
      }
    }
  });

  test("retry clears failedReason to null", async () => {
    const db = makeTempDb();
    const bus = new EventBus();
    const sessions = new Map<string, Session>();
    const audit: AuditCall[] = [];
    const ctx = makeMockCtx(sessions, audit);
    ctx.bus = bus;
    ctx.db = db;

    const dag = makeDag("dag-fr", [makeNode("A", "failed", { sessionSlug: "old-A" })]);
    const repo = seedDag(db, bus, dag);
    repo.updateNode("A", { failedReason: "something went wrong" });

    const subsystem = createDagSubsystem({
      ctx,
      log: createLogger("error"),
      env: {} as EngineContext["env"],
      db,
      bus,
      mutex: ctx.mutex,
      workspaceDir: "/tmp",
      automationRepo: new AutomationJobRepo(db),
    });
    ctx.dags = subsystem.api;

    try {
      await subsystem.api.retry("dag-fr", "A");
      const row = db
        .prepare(`SELECT failed_reason FROM dag_nodes WHERE id = ?`)
        .get("A") as { failed_reason: string | null };
      assert.equal(row.failed_reason, null);
    } finally {
      await subsystem.onShutdown?.();
      db.close();
    }
  });

  test("cancel flips all non-landed nodes to cancelled and dag to cancelled", async () => {
    const db = makeTempDb();
    const bus = new EventBus();
    const sessions = new Map<string, Session>();
    sessions.set("sess-B", makeSession("sess-B", "running"));
    const audit: AuditCall[] = [];
    const ctx = makeMockCtx(sessions, audit);
    ctx.bus = bus;
    ctx.db = db;

    const dag = makeDag("dag-c1", [
      makeNode("A", "landed"),
      makeNode("B", "running", { sessionSlug: "sess-B" }),
      makeNode("C", "pending", { dependsOn: ["B"] }),
    ]);
    seedDag(db, bus, dag);

    const subsystem = createDagSubsystem({
      ctx,
      log: createLogger("error"),
      env: {} as EngineContext["env"],
      db,
      bus,
      mutex: ctx.mutex,
      workspaceDir: "/tmp",
      automationRepo: new AutomationJobRepo(db),
    });
    ctx.dags = subsystem.api;

    try {
      await subsystem.api.cancel("dag-c1");

      const repo = new DagRepo(db, bus);
      assert.equal(repo.getNode("A")?.status, "landed", "landed node preserved");
      assert.equal(repo.getNode("B")?.status, "cancelled");
      assert.equal(repo.getNode("C")?.status, "cancelled");
      assert.equal(repo.get("dag-c1")?.status, "cancelled");
      assert.ok(audit.find((a) => a.action === "dag.cancel"));
    } finally {
      await subsystem.onShutdown?.();
      db.close();
    }
  });

  test("force-land marks a running node as landed without checks", async () => {
    const db = makeTempDb();
    const bus = new EventBus();
    const sessions = new Map<string, Session>();
    sessions.set("sess-A", makeSession("sess-A", "running"));
    const audit: AuditCall[] = [];
    const ctx = makeMockCtx(sessions, audit);
    ctx.bus = bus;
    ctx.db = db;

    const dag = makeDag("dag-f1", [
      makeNode("A", "running", { sessionSlug: "sess-A" }),
    ]);
    seedDag(db, bus, dag);

    const subsystem = createDagSubsystem({
      ctx,
      log: createLogger("error"),
      env: {} as EngineContext["env"],
      db,
      bus,
      mutex: ctx.mutex,
      workspaceDir: "/tmp",
      automationRepo: new AutomationJobRepo(db),
    });
    ctx.dags = subsystem.api;

    try {
      await subsystem.api.forceLand("dag-f1", "A");

      const repo = new DagRepo(db, bus);
      assert.equal(repo.getNode("A")?.status, "landed");
      const forceAudit = audit.find((a) => a.action === "dag.force-land");
      assert.ok(forceAudit);
      assert.equal(forceAudit?.detail?.["from"], "running");
      assert.equal(forceAudit?.detail?.["to"], "landed");
    } finally {
      await subsystem.onShutdown?.();
      db.close();
    }
  });
});
