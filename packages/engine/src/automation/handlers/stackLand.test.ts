import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import type {
  AttentionFlag,
  DAGNodeStatus,
  PRSummary,
  Session,
} from "@minions/shared";
import { openStore } from "../../store/sqlite.js";
import { createLogger } from "../../logger.js";
import { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import { DagRepo } from "../../dag/model.js";
import { EventBus } from "../../bus/eventBus.js";
import type { EngineContext } from "../../context.js";
import { createStackLandHandler, enqueueStackLand } from "./stackLand.js";

interface NodeSpec {
  id: string;
  status: DAGNodeStatus;
  dependsOn?: string[];
  sessionSlug?: string;
}

interface Env {
  db: Database.Database;
  bus: EventBus;
  automationRepo: AutomationJobRepo;
  dagRepo: DagRepo;
  cleanup: () => void;
}

function setup(): Env {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-stackland-"));
  const dbPath = path.join(tmpDir, "test.db");
  const log = createLogger("error");
  const db = openStore({ path: dbPath, log });
  const bus = new EventBus();
  const automationRepo = new AutomationJobRepo(db);
  const dagRepo = new DagRepo(db, bus);
  return {
    db,
    bus,
    automationRepo,
    dagRepo,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function createDagWithNodes(env: Env, dagId: string, nodes: NodeSpec[]): string[] {
  const now = new Date().toISOString();
  env.dagRepo.insert({
    id: dagId,
    title: "stack-land test",
    goal: "land in order",
    status: "active",
    metadata: {},
    createdAt: now,
    updatedAt: now,
  });
  const created: string[] = [];
  let ord = 0;
  for (const spec of nodes) {
    const inserted = env.dagRepo.insertNode(
      dagId,
      {
        title: spec.id,
        prompt: spec.id,
        status: spec.status,
        dependsOn: [],
        sessionSlug: spec.sessionSlug,
        metadata: {},
      },
      ord++,
    );
    created.push(inserted.id);
  }
  for (let i = 0; i < nodes.length; i++) {
    const spec = nodes[i]!;
    if (!spec.dependsOn || spec.dependsOn.length === 0) continue;
    const realDeps = spec.dependsOn.map((depIdx) => {
      const idx = nodes.findIndex((n) => n.id === depIdx);
      if (idx < 0) throw new Error(`unknown dep ${depIdx}`);
      return created[idx]!;
    });
    env.dagRepo.updateNode(created[i]!, { dependsOn: realDeps });
  }
  return created;
}

function makeSession(opts: {
  slug: string;
  prState?: PRSummary["state"];
  attention?: AttentionFlag["kind"][];
}): Session {
  const now = new Date().toISOString();
  const attention: AttentionFlag[] = (opts.attention ?? []).map((kind) => ({
    kind,
    message: kind,
    raisedAt: now,
  }));
  const pr: PRSummary = {
    number: 1,
    url: "https://example.test/pr/1",
    state: opts.prState ?? "open",
    draft: false,
    base: "main",
    head: opts.slug,
    title: opts.slug,
  };
  return {
    slug: opts.slug,
    title: opts.slug,
    prompt: "test",
    mode: "dag-task",
    status: "running",
    pr,
    attention,
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

interface MockCtxOpts {
  sessions: Session[];
  landResult?: "ok" | "throw";
  landError?: string;
}

interface MockCtxResult {
  ctx: EngineContext;
  landCalls: string[];
  landArgs: Array<{ slug: string; strategy?: "merge" | "squash" | "rebase"; force?: boolean }>;
  audits: { action: string; detail: Record<string, unknown> }[];
}

function makeCtx(opts: MockCtxOpts): MockCtxResult {
  const sessions = new Map(opts.sessions.map((s) => [s.slug, s] as const));
  const landCalls: string[] = [];
  const landArgs: Array<{ slug: string; strategy?: "merge" | "squash" | "rebase"; force?: boolean }> = [];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];

  const ctx = {
    sessions: {
      get: (slug: string) => sessions.get(slug) ?? null,
    },
    landing: {
      land: async (slug: string, strategy?: "merge" | "squash" | "rebase", force?: boolean) => {
        landCalls.push(slug);
        landArgs.push({ slug, strategy, force });
        if (opts.landResult === "throw") {
          throw new Error(opts.landError ?? "merge conflict");
        }
      },
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
  } as unknown as EngineContext;

  return { ctx, landCalls, landArgs, audits };
}

describe("stackLand handler", () => {
  it("succeeds without action when all nodes are already merged", async () => {
    const env = setup();
    try {
      createDagWithNodes(env, "dag-all-merged", [
        { id: "a", status: "merged" },
        { id: "b", status: "merged", dependsOn: ["a"] },
      ]);
      const { ctx, landCalls, audits } = makeCtx({ sessions: [] });

      const handler = createStackLandHandler({
        automationRepo: env.automationRepo,
        dagRepo: env.dagRepo,
      });
      const job = enqueueStackLand(env.automationRepo, "dag-all-merged");
      await handler(env.automationRepo.get(job.id)!, ctx);

      assert.deepEqual(landCalls, []);
      const followUps = env.automationRepo
        .findByTarget("dag", "dag-all-merged")
        .filter((j) => j.id !== job.id);
      assert.equal(followUps.length, 0, "no follow-up enqueued when everything merged");
      const completes = audits.filter((a) => a.action === "dag.stack-land.complete");
      assert.equal(completes.length, 1);
    } finally {
      env.cleanup();
    }
  });

  it("merges first ready pr-open node and advances state", async () => {
    const env = setup();
    try {
      const nodeIds = createDagWithNodes(env, "dag-merge-first", [
        { id: "a", status: "pr-open", sessionSlug: "sess-a" },
        { id: "b", status: "pending", dependsOn: ["a"] },
      ]);
      const sessions = [
        makeSession({ slug: "sess-a", prState: "open", attention: ["ci_passed"] }),
      ];
      const { ctx, landCalls, audits } = makeCtx({ sessions });

      const handler = createStackLandHandler({
        automationRepo: env.automationRepo,
        dagRepo: env.dagRepo,
      });
      const job = enqueueStackLand(env.automationRepo, "dag-merge-first");
      await handler(env.automationRepo.get(job.id)!, ctx);

      assert.deepEqual(landCalls, ["sess-a"], "first node was landed");
      const updatedA = env.dagRepo.getNode(nodeIds[0]!);
      assert.equal(updatedA?.status, "merged", "node a marked merged");

      const merged = audits.filter((a) => a.action === "dag.stack-land.merged");
      assert.equal(merged.length, 1);

      const followUps = env.automationRepo
        .findByTarget("dag", "dag-merge-first")
        .filter((j) => j.id !== job.id && j.kind === "stack-land");
      assert.equal(
        followUps.length,
        1,
        "re-enqueued because pending node b still needs work",
      );
      const completes = audits.filter((a) => a.action === "dag.stack-land.complete");
      assert.equal(completes.length, 0, "complete audit not emitted while work remains");
    } finally {
      env.cleanup();
    }
  });

  it("lands pr-open nodes after the dag has already been marked completed", async () => {
    const env = setup();
    try {
      const nodeIds = createDagWithNodes(env, "dag-completed-pr-open", [
        { id: "a", status: "pr-open", sessionSlug: "sess-a" },
      ]);
      env.dagRepo.update("dag-completed-pr-open", { status: "completed" });
      const sessions = [
        makeSession({ slug: "sess-a", prState: "open", attention: ["ci_passed"] }),
      ];
      const { ctx, landCalls, audits } = makeCtx({ sessions });

      const handler = createStackLandHandler({
        automationRepo: env.automationRepo,
        dagRepo: env.dagRepo,
      });
      const job = enqueueStackLand(env.automationRepo, "dag-completed-pr-open");
      await handler(env.automationRepo.get(job.id)!, ctx);

      assert.deepEqual(landCalls, ["sess-a"], "completed dag with pr-open node still lands");
      const updatedA = env.dagRepo.getNode(nodeIds[0]!);
      assert.equal(updatedA?.status, "merged", "node marked merged");

      const completes = audits.filter((a) => a.action === "dag.stack-land.complete");
      assert.equal(completes.length, 1);
    } finally {
      env.cleanup();
    }
  });

  it("re-enqueues when the next node is still pending", async () => {
    const env = setup();
    try {
      createDagWithNodes(env, "dag-pending", [
        { id: "a", status: "merged" },
        { id: "b", status: "pending", dependsOn: ["a"] },
      ]);
      const { ctx, landCalls } = makeCtx({ sessions: [] });

      const handler = createStackLandHandler({
        automationRepo: env.automationRepo,
        dagRepo: env.dagRepo,
      });
      const job = enqueueStackLand(env.automationRepo, "dag-pending");
      await handler(env.automationRepo.get(job.id)!, ctx);

      assert.deepEqual(landCalls, [], "no landing call when next node is pending");
      const followUps = env.automationRepo
        .findByTarget("dag", "dag-pending")
        .filter((j) => j.id !== job.id && j.kind === "stack-land");
      assert.equal(followUps.length, 1, "re-enqueued one follow-up");
      const followUp = followUps[0]!;
      const delayMs = new Date(followUp.nextRunAt).getTime() - Date.now();
      assert.ok(
        delayMs > 55_000 && delayMs < 65_000,
        `expected ~60s delay, got ${delayMs}ms`,
      );
    } finally {
      env.cleanup();
    }
  });

  it("re-enqueues and audits failure when merge throws (conflict)", async () => {
    const env = setup();
    try {
      const nodeIds = createDagWithNodes(env, "dag-conflict", [
        { id: "a", status: "pr-open", sessionSlug: "sess-a" },
      ]);
      const sessions = [
        makeSession({ slug: "sess-a", prState: "open", attention: ["ci_passed"] }),
      ];
      const { ctx, landCalls, audits } = makeCtx({
        sessions,
        landResult: "throw",
        landError: "rebase conflict during land",
      });

      const handler = createStackLandHandler({
        automationRepo: env.automationRepo,
        dagRepo: env.dagRepo,
      });
      const job = enqueueStackLand(env.automationRepo, "dag-conflict");
      await handler(env.automationRepo.get(job.id)!, ctx);

      assert.deepEqual(landCalls, ["sess-a"], "land was attempted");
      const updatedA = env.dagRepo.getNode(nodeIds[0]!);
      assert.equal(updatedA?.status, "pr-open", "node stays pr-open after failure");

      const failed = audits.filter((a) => a.action === "dag.stack-land.merge-failed");
      assert.equal(failed.length, 1);
      assert.match(String(failed[0]!.detail["error"]), /rebase conflict/);

      const followUps = env.automationRepo
        .findByTarget("dag", "dag-conflict")
        .filter((j) => j.id !== job.id && j.kind === "stack-land");
      assert.equal(followUps.length, 1, "re-enqueued after merge failure");
    } finally {
      env.cleanup();
    }
  });

  it("succeeds without action when dag is not active (cancelled)", async () => {
    const env = setup();
    try {
      createDagWithNodes(env, "dag-cancelled", [
        { id: "a", status: "pr-open", sessionSlug: "sess-a" },
      ]);
      env.dagRepo.update("dag-cancelled", { status: "cancelled" });
      const sessions = [
        makeSession({ slug: "sess-a", prState: "open", attention: ["ci_passed"] }),
      ];
      const { ctx, landCalls } = makeCtx({ sessions });

      const handler = createStackLandHandler({
        automationRepo: env.automationRepo,
        dagRepo: env.dagRepo,
      });
      const job = enqueueStackLand(env.automationRepo, "dag-cancelled");
      await handler(env.automationRepo.get(job.id)!, ctx);

      assert.deepEqual(landCalls, [], "no merge attempted on cancelled dag");
      const followUps = env.automationRepo
        .findByTarget("dag", "dag-cancelled")
        .filter((j) => j.id !== job.id && j.kind === "stack-land");
      assert.equal(followUps.length, 0, "no follow-up for cancelled dag");
    } finally {
      env.cleanup();
    }
  });

  it("lands the stack when dag.status is completed (all nodes pr-open)", async () => {
    const env = setup();
    try {
      const nodeIds = createDagWithNodes(env, "dag-completed", [
        { id: "a", status: "pr-open", sessionSlug: "sess-a" },
        { id: "b", status: "pr-open", sessionSlug: "sess-b", dependsOn: ["a"] },
      ]);
      env.dagRepo.update("dag-completed", { status: "completed" });
      const sessions = [
        makeSession({ slug: "sess-a", prState: "open", attention: ["ci_passed"] }),
        makeSession({ slug: "sess-b", prState: "open", attention: ["ci_passed"] }),
      ];
      const { ctx, landCalls, audits } = makeCtx({ sessions });

      const handler = createStackLandHandler({
        automationRepo: env.automationRepo,
        dagRepo: env.dagRepo,
      });
      const job = enqueueStackLand(env.automationRepo, "dag-completed");
      await handler(env.automationRepo.get(job.id)!, ctx);

      assert.deepEqual(landCalls, ["sess-a", "sess-b"], "both nodes landed in topo order");
      assert.equal(env.dagRepo.getNode(nodeIds[0]!)?.status, "merged");
      assert.equal(env.dagRepo.getNode(nodeIds[1]!)?.status, "merged");
      const completes = audits.filter((a) => a.action === "dag.stack-land.complete");
      assert.equal(completes.length, 1, "complete audit emitted after stack lands");
    } finally {
      env.cleanup();
    }
  });

  it("skips a pr-open node with no PR (e.g., verify node) and marks it merged", async () => {
    const env = setup();
    try {
      const nodeIds = createDagWithNodes(env, "dag-verify", [
        { id: "a", status: "pr-open", sessionSlug: "sess-a" },
        { id: "verify", status: "pr-open", sessionSlug: "sess-verify", dependsOn: ["a"] },
      ]);
      env.dagRepo.update("dag-verify", { status: "completed" });
      const verifySession = {
        ...makeSession({ slug: "sess-verify" }),
        pr: undefined,
      };
      const sessions = [
        makeSession({ slug: "sess-a", prState: "open", attention: ["ci_passed"] }),
        verifySession,
      ];
      const { ctx, landCalls, audits } = makeCtx({ sessions });

      const handler = createStackLandHandler({
        automationRepo: env.automationRepo,
        dagRepo: env.dagRepo,
      });
      const job = enqueueStackLand(env.automationRepo, "dag-verify");
      await handler(env.automationRepo.get(job.id)!, ctx);

      assert.deepEqual(landCalls, ["sess-a"], "only the node with a PR is landed");
      assert.equal(env.dagRepo.getNode(nodeIds[1]!)?.status, "merged");
      const skipped = audits.filter((a) => a.action === "dag.stack-land.skipped");
      assert.equal(skipped.length, 1, "verify node skip audited");
      assert.equal(skipped[0]!.detail["reason"], "no-pr");
      const completes = audits.filter((a) => a.action === "dag.stack-land.complete");
      assert.equal(completes.length, 1);
    } finally {
      env.cleanup();
    }
  });

  it("calls landing.land with force=true so unattended runs bypass review-gated readiness", async () => {
    const env = setup();
    try {
      createDagWithNodes(env, "dag-force", [
        { id: "a", status: "pr-open", sessionSlug: "sess-a" },
      ]);
      const sessions = [
        makeSession({ slug: "sess-a", prState: "open", attention: ["ci_passed"] }),
      ];
      const { ctx, landArgs } = makeCtx({ sessions });

      const handler = createStackLandHandler({
        automationRepo: env.automationRepo,
        dagRepo: env.dagRepo,
      });
      const job = enqueueStackLand(env.automationRepo, "dag-force");
      await handler(env.automationRepo.get(job.id)!, ctx);

      assert.equal(landArgs.length, 1);
      assert.equal(landArgs[0]!.force, true, "force=true required: stack-land has its own readiness gate");
      assert.equal(landArgs[0]!.strategy, "squash");
    } finally {
      env.cleanup();
    }
  });

  it("treats a PR that is already merged on GitHub as a no-op merged node", async () => {
    const env = setup();
    try {
      const nodeIds = createDagWithNodes(env, "dag-already-merged", [
        { id: "a", status: "pr-open", sessionSlug: "sess-a" },
      ]);
      const sessions = [
        makeSession({ slug: "sess-a", prState: "merged", attention: ["ci_passed"] }),
      ];
      const { ctx, landCalls, audits } = makeCtx({ sessions });

      const handler = createStackLandHandler({
        automationRepo: env.automationRepo,
        dagRepo: env.dagRepo,
      });
      const job = enqueueStackLand(env.automationRepo, "dag-already-merged");
      await handler(env.automationRepo.get(job.id)!, ctx);

      assert.deepEqual(landCalls, [], "no land call when PR is already merged upstream");
      assert.equal(env.dagRepo.getNode(nodeIds[0]!)?.status, "merged");
      const completes = audits.filter((a) => a.action === "dag.stack-land.complete");
      assert.equal(completes.length, 1);
    } finally {
      env.cleanup();
    }
  });
});
