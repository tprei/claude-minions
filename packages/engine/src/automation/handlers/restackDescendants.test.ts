import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import type {
  AttentionFlag,
  PRSummary,
  Session,
} from "@minions/shared";
import { openStore } from "../../store/sqlite.js";
import { createLogger } from "../../logger.js";
import { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import { DagRepo } from "../../dag/model.js";
import { EventBus } from "../../bus/eventBus.js";
import type { EngineContext } from "../../context.js";
import {
  createRestackDescendantsHandler,
  enqueueRestackDescendants,
} from "./restackDescendants.js";

interface Env {
  db: Database.Database;
  bus: EventBus;
  automationRepo: AutomationJobRepo;
  dagRepo: DagRepo;
  cleanup: () => void;
}

function setup(): Env {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-restack-desc-"));
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

interface MakeSessionOpts {
  slug: string;
  branch?: string;
  baseBranch?: string;
  prState?: PRSummary["state"];
  prBase?: string;
}

function makeSession(opts: MakeSessionOpts): Session {
  const now = new Date().toISOString();
  const branch = opts.branch ?? opts.slug;
  const baseBranch = opts.baseBranch ?? "main";
  const pr: PRSummary = {
    number: 1,
    url: "https://example.test/pr/1",
    state: opts.prState ?? "open",
    draft: false,
    base: opts.prBase ?? baseBranch,
    head: branch,
    title: opts.slug,
  };
  return {
    slug: opts.slug,
    title: opts.slug,
    prompt: "test",
    mode: "dag-task",
    status: "running",
    branch,
    baseBranch,
    pr,
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

interface CtxRecord {
  ctx: EngineContext;
  editPRBaseCalls: { slug: string; newBase: string }[];
  rebaseCalls: string[];
  appendedAttention: { slug: string; flag: AttentionFlag }[];
  audits: { action: string; detail: Record<string, unknown> }[];
}

interface MakeCtxOpts {
  sessions: Session[];
  rebaseFailures?: Record<string, string>;
  editPRBaseFailures?: Record<string, string>;
}

function makeCtx(opts: MakeCtxOpts): CtxRecord {
  const sessionMap = new Map(opts.sessions.map((s) => [s.slug, s] as const));
  const editPRBaseCalls: { slug: string; newBase: string }[] = [];
  const rebaseCalls: string[] = [];
  const appendedAttention: { slug: string; flag: AttentionFlag }[] = [];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];

  const ctx = {
    sessions: {
      get: (slug: string) => sessionMap.get(slug) ?? null,
      list: () => Array.from(sessionMap.values()),
      appendAttention: (slug: string, flag: AttentionFlag) => {
        appendedAttention.push({ slug, flag });
        const s = sessionMap.get(slug);
        if (s) sessionMap.set(slug, { ...s, attention: [...s.attention, flag] });
      },
    },
    landing: {
      editPRBase: async (slug: string, newBase: string) => {
        editPRBaseCalls.push({ slug, newBase });
        if (opts.editPRBaseFailures?.[slug]) {
          throw new Error(opts.editPRBaseFailures[slug]);
        }
        const s = sessionMap.get(slug);
        if (s && s.pr) {
          sessionMap.set(slug, {
            ...s,
            baseBranch: newBase,
            pr: { ...s.pr, base: newBase },
          });
        }
      },
      retryRebase: async (slug: string) => {
        rebaseCalls.push(slug);
        if (opts.rebaseFailures?.[slug]) {
          throw new Error(opts.rebaseFailures[slug]);
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

  return { ctx, editPRBaseCalls, rebaseCalls, appendedAttention, audits };
}

describe("restackDescendants handler", () => {
  it("succeeds without action when there are no descendants", async () => {
    const env = setup();
    try {
      const merged = makeSession({ slug: "parent", branch: "feat-parent" });
      const { ctx, editPRBaseCalls, rebaseCalls, appendedAttention, audits } =
        makeCtx({ sessions: [merged] });

      const handler = createRestackDescendantsHandler({
        automationRepo: env.automationRepo,
        dagRepo: env.dagRepo,
      });
      const job = enqueueRestackDescendants(env.automationRepo, "parent");
      await handler(env.automationRepo.get(job.id)!, ctx);

      assert.deepEqual(editPRBaseCalls, []);
      assert.deepEqual(rebaseCalls, []);
      assert.deepEqual(appendedAttention, []);
      const completes = audits.filter(
        (a) => a.action === "restack-descendants.complete",
      );
      assert.equal(completes.length, 1);
      assert.equal(completes[0]!.detail["descendantCount"], 0);
    } finally {
      env.cleanup();
    }
  });

  it("rebases descendant cleanly: updates PR base, rebases, enqueues stack-land", async () => {
    const env = setup();
    try {
      const merged = makeSession({
        slug: "parent",
        branch: "feat-parent",
        baseBranch: "main",
      });
      const child = makeSession({
        slug: "child",
        branch: "feat-child",
        baseBranch: "feat-parent",
        prBase: "feat-parent",
      });

      const now = new Date().toISOString();
      env.dagRepo.insert({
        id: "dag-child",
        title: "child dag",
        goal: "land child",
        status: "active",
        metadata: {},
        createdAt: now,
        updatedAt: now,
      });
      env.dagRepo.insertNode(
        "dag-child",
        {
          title: "child node",
          prompt: "child node",
          status: "pr-open",
          dependsOn: [],
          sessionSlug: "child",
          metadata: {},
        },
        0,
      );

      const { ctx, editPRBaseCalls, rebaseCalls, appendedAttention, audits } =
        makeCtx({ sessions: [merged, child] });

      const handler = createRestackDescendantsHandler({
        automationRepo: env.automationRepo,
        dagRepo: env.dagRepo,
      });
      const job = enqueueRestackDescendants(env.automationRepo, "parent");
      await handler(env.automationRepo.get(job.id)!, ctx);

      assert.deepEqual(editPRBaseCalls, [{ slug: "child", newBase: "main" }]);
      assert.deepEqual(rebaseCalls, ["child"]);
      assert.deepEqual(appendedAttention, [], "no attention persisted on clean rebase");

      const stackLandJobs = env.automationRepo
        .findByTarget("dag", "dag-child")
        .filter((j) => j.kind === "stack-land");
      assert.equal(stackLandJobs.length, 1, "stack-land enqueued for descendant DAG");

      const restacked = audits.filter(
        (a) => a.action === "restack-descendants.restacked",
      );
      assert.equal(restacked.length, 1);

      const completes = audits.filter(
        (a) => a.action === "restack-descendants.complete",
      );
      assert.equal(completes.length, 1);
      assert.equal(completes[0]!.detail["descendantCount"], 1);
    } finally {
      env.cleanup();
    }
  });

  it("persists rebase_conflict attention when descendant rebase fails", async () => {
    const env = setup();
    try {
      const merged = makeSession({
        slug: "parent",
        branch: "feat-parent",
        baseBranch: "main",
      });
      const child = makeSession({
        slug: "child",
        branch: "feat-child",
        baseBranch: "feat-parent",
        prBase: "feat-parent",
      });

      const { ctx, editPRBaseCalls, rebaseCalls, appendedAttention, audits } =
        makeCtx({
          sessions: [merged, child],
          rebaseFailures: { child: "rebase conflict in foo.ts" },
        });

      const handler = createRestackDescendantsHandler({
        automationRepo: env.automationRepo,
        dagRepo: env.dagRepo,
      });
      const job = enqueueRestackDescendants(env.automationRepo, "parent");
      await handler(env.automationRepo.get(job.id)!, ctx);

      assert.deepEqual(editPRBaseCalls, [{ slug: "child", newBase: "main" }]);
      assert.deepEqual(rebaseCalls, ["child"]);

      assert.equal(appendedAttention.length, 1, "attention persisted");
      assert.equal(appendedAttention[0]!.slug, "child");
      assert.equal(appendedAttention[0]!.flag.kind, "rebase_conflict");
      assert.match(appendedAttention[0]!.flag.message, /descendant rebase failed/);

      const stackLandJobs = env.automationRepo
        .findByTarget("dag", "dag-child")
        .filter((j) => j.kind === "stack-land");
      assert.equal(stackLandJobs.length, 0, "no stack-land enqueued on conflict");

      const conflicts = audits.filter(
        (a) => a.action === "restack-descendants.rebase-conflict",
      );
      assert.equal(conflicts.length, 1);
    } finally {
      env.cleanup();
    }
  });
});
