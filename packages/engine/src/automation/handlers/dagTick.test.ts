import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { openStore } from "../../store/sqlite.js";
import { createLogger } from "../../logger.js";
import { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import type { EngineContext } from "../../context.js";
import { createDagTickHandler, enqueueDagTick } from "./dagTick.js";

interface Env {
  db: Database.Database;
  repo: AutomationJobRepo;
  cleanup: () => void;
}

function setup(): Env {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-dag-tick-"));
  const dbPath = path.join(tmpDir, "test.db");
  const log = createLogger("error");
  const db = openStore({ path: dbPath, log });
  const repo = new AutomationJobRepo(db);
  return {
    db,
    repo,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function makeCtx(): { ctx: EngineContext; tickCalls: string[] } {
  const tickCalls: string[] = [];
  const ctx = {
    dags: {
      tick: async (dagId: string) => {
        tickCalls.push(dagId);
      },
    },
  } as unknown as EngineContext;
  return { ctx, tickCalls };
}

describe("dagTick handler", () => {
  it("ticks the named DAG via ctx.dags.tick", async () => {
    const env = setup();
    try {
      const { ctx, tickCalls } = makeCtx();
      const handler = createDagTickHandler();
      const job = enqueueDagTick(env.repo, "dag-abc");
      await handler(env.repo.get(job.id)!, ctx);
      assert.deepEqual(tickCalls, ["dag-abc"]);
    } finally {
      env.cleanup();
    }
  });

  it("returns silently when payload has no dagId", async () => {
    const env = setup();
    try {
      const { ctx, tickCalls } = makeCtx();
      const handler = createDagTickHandler();
      const job = env.repo.enqueue({
        kind: "dag-tick",
        targetKind: "dag",
        targetId: "missing",
        payload: {},
      });
      await handler(env.repo.get(job.id)!, ctx);
      assert.deepEqual(tickCalls, [], "no tick when payload missing dagId");
    } finally {
      env.cleanup();
    }
  });

  it("enqueueDagTick honors the delay", () => {
    const env = setup();
    try {
      const baseDate = new Date("2026-01-01T00:00:00.000Z");
      const job = enqueueDagTick(env.repo, "dag-z", 30_000, () => baseDate);
      assert.equal(job.kind, "dag-tick");
      assert.equal(job.targetKind, "dag");
      assert.equal(job.targetId, "dag-z");
      assert.equal(job.nextRunAt, "2026-01-01T00:00:30.000Z");
    } finally {
      env.cleanup();
    }
  });
});
