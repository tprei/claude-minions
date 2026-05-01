import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { ResourceSnapshot } from "@minions/shared";
import { runMigrations } from "../store/sqlite.js";
import { createLogger } from "../logger.js";
import { EventBus } from "../bus/eventBus.js";
import { KeyedMutex } from "../util/mutex.js";
import { createResourceSubsystem } from "./index.js";
import type { SubsystemDeps } from "../wiring.js";
import type { EngineContext } from "../context.js";

interface LifecycleCall {
  eventType: string;
  severity: string;
  message: string;
  detail?: Record<string, unknown>;
}

interface PushCall {
  sessionSlug: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

function makeSnapshot(memUsedPct: number, diskUsedPct: number): ResourceSnapshot {
  return {
    timestamp: new Date().toISOString(),
    cgroupAware: true,
    cpu: { usagePct: 0, limitCores: 1, cores: 1 },
    memory: {
      usedBytes: memUsedPct,
      limitBytes: 100,
      rssBytes: 0,
    },
    disk: {
      usedBytes: diskUsedPct,
      totalBytes: 100,
      workspacePath: "/tmp/ws",
      workspaceUsedBytes: 0,
    },
    eventLoop: { lagMs: 0 },
    sessions: { total: 0, running: 0, waiting: 0 },
  };
}

function makeDeps(
  db: Database.Database,
  lifecycleCalls: LifecycleCall[],
  pushCalls: PushCall[],
  runtimeOverrides: Record<string, unknown>,
  sample: () => Promise<ResourceSnapshot>,
): { deps: SubsystemDeps; ctx: EngineContext } {
  const log = createLogger("error");
  const ctx = {
    runtime: {
      schema: () => ({ groups: [], fields: [] }),
      values: () => runtimeOverrides,
      effective: () => runtimeOverrides,
      update: async () => {},
    },
    lifecycle: {
      async record(input: LifecycleCall) {
        lifecycleCalls.push(input);
      },
      list: () => ({ items: [] }),
    },
    push: {
      vapidPublicKey: () => null,
      async subscribe() {},
      async unsubscribe() {},
      async notify(
        sessionSlug: string,
        title: string,
        body: string,
        data?: Record<string, unknown>,
      ) {
        pushCalls.push({ sessionSlug, title, body, data });
      },
    },
  } as unknown as EngineContext;

  const deps: SubsystemDeps = {
    ctx,
    log,
    env: { resourceSampleSec: 60 } as SubsystemDeps["env"],
    db,
    bus: new EventBus(),
    mutex: new KeyedMutex(),
    workspaceDir: "/tmp/resource-test",
  };
  return { deps, ctx };
}

describe("createResourceSubsystem alert wiring", () => {
  let db: Database.Database;
  let lifecycleCalls: LifecycleCall[];
  let pushCalls: PushCall[];

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, createLogger("error"));
    lifecycleCalls = [];
    pushCalls = [];
  });

  afterEach(() => {
    db.close();
  });

  test("fires once over threshold and respects cooldown on the next tick", async () => {
    let snapshotPct = 95;
    const sample = async () => makeSnapshot(snapshotPct, 10);
    const { deps } = makeDeps(
      db,
      lifecycleCalls,
      pushCalls,
      {
        resourceMemoryAlertPct: 90,
        resourceDiskAlertPct: 90,
        resourceAlertCooldownMin: 60,
        pushNotifyOnResourceAlert: true,
      },
      sample,
    );

    const { api } = createResourceSubsystem(deps, { sample });

    await api.tick();
    assert.equal(lifecycleCalls.length, 1, "first tick should record one alert");
    assert.equal(lifecycleCalls[0]!.eventType, "resource.alert");
    assert.equal(lifecycleCalls[0]!.detail?.["resource"], "memory");
    assert.equal(pushCalls.length, 1, "first tick should push one notification");
    assert.match(pushCalls[0]!.title, /memory usage at 95%/);

    await api.tick();
    assert.equal(lifecycleCalls.length, 1, "second tick within cooldown should not fire");
    assert.equal(pushCalls.length, 1, "second tick within cooldown should not push");

    snapshotPct = 50;
    await api.tick();
    assert.equal(lifecycleCalls.length, 1, "below threshold should not fire");
    assert.equal(pushCalls.length, 1, "below threshold should not push");
  });

  test("respects pushNotifyOnResourceAlert=false (records but does not push)", async () => {
    const sample = async () => makeSnapshot(95, 10);
    const { deps } = makeDeps(
      db,
      lifecycleCalls,
      pushCalls,
      {
        resourceMemoryAlertPct: 90,
        resourceDiskAlertPct: 90,
        resourceAlertCooldownMin: 60,
        pushNotifyOnResourceAlert: false,
      },
      sample,
    );

    const { api } = createResourceSubsystem(deps, { sample });

    await api.tick();
    assert.equal(lifecycleCalls.length, 1);
    assert.equal(pushCalls.length, 0);
  });

  test("disk and memory both alerting fire independently", async () => {
    const sample = async () => makeSnapshot(95, 95);
    const { deps } = makeDeps(
      db,
      lifecycleCalls,
      pushCalls,
      {
        resourceMemoryAlertPct: 90,
        resourceDiskAlertPct: 90,
        resourceAlertCooldownMin: 60,
        pushNotifyOnResourceAlert: true,
      },
      sample,
    );

    const { api } = createResourceSubsystem(deps, { sample });

    await api.tick();
    assert.equal(lifecycleCalls.length, 2);
    const resources = lifecycleCalls.map((c) => c.detail?.["resource"]).sort();
    assert.deepEqual(resources, ["disk", "memory"]);
    assert.equal(pushCalls.length, 2);
  });
});
