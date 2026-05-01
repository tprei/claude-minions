import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ResourceSnapshot } from "@minions/shared";
import {
  decideResourceAlert,
  type LastFiredMap,
  type ResourceAlertThresholds,
} from "./decideAlert.js";

function snapshot(overrides: {
  memUsed?: number;
  memLimit?: number;
  diskUsed?: number;
  diskTotal?: number;
}): ResourceSnapshot {
  return {
    timestamp: "2026-05-01T00:00:00.000Z",
    cgroupAware: true,
    cpu: { usagePct: 0, limitCores: 1, cores: 1 },
    memory: {
      usedBytes: overrides.memUsed ?? 0,
      limitBytes: overrides.memLimit ?? 0,
      rssBytes: 0,
    },
    disk: {
      usedBytes: overrides.diskUsed ?? 0,
      totalBytes: overrides.diskTotal ?? 0,
      workspacePath: "/tmp/ws",
      workspaceUsedBytes: 0,
    },
    eventLoop: { lagMs: 0 },
    sessions: { total: 0, running: 0, waiting: 0 },
  };
}

const thresholds: ResourceAlertThresholds = {
  memoryPct: 90,
  diskPct: 90,
  cooldownMs: 60 * 60 * 1000,
};

const neverFired: LastFiredMap = { memory: 0, disk: 0 };

describe("decideResourceAlert", () => {
  test("under threshold returns null", () => {
    const r = decideResourceAlert(
      snapshot({ memUsed: 50, memLimit: 100, diskUsed: 50, diskTotal: 100 }),
      thresholds,
      neverFired,
      Date.now(),
    );
    assert.equal(r.memory, null);
    assert.equal(r.disk, null);
  });

  test("over threshold first time fires", () => {
    const now = Date.now();
    const r = decideResourceAlert(
      snapshot({ memUsed: 95, memLimit: 100, diskUsed: 95, diskTotal: 100 }),
      thresholds,
      neverFired,
      now,
    );
    assert.deepEqual(r.memory, { pct: 95, threshold: 90 });
    assert.deepEqual(r.disk, { pct: 95, threshold: 90 });
  });

  test("over threshold inside cooldown does not fire", () => {
    const now = Date.now();
    const lastFired: LastFiredMap = {
      memory: now - 30 * 60 * 1000,
      disk: now - 30 * 60 * 1000,
    };
    const r = decideResourceAlert(
      snapshot({ memUsed: 95, memLimit: 100, diskUsed: 95, diskTotal: 100 }),
      thresholds,
      lastFired,
      now,
    );
    assert.equal(r.memory, null);
    assert.equal(r.disk, null);
  });

  test("over threshold after cooldown fires again", () => {
    const now = Date.now();
    const lastFired: LastFiredMap = {
      memory: now - (60 * 60 * 1000 + 1),
      disk: now - (60 * 60 * 1000 + 1),
    };
    const r = decideResourceAlert(
      snapshot({ memUsed: 95, memLimit: 100, diskUsed: 95, diskTotal: 100 }),
      thresholds,
      lastFired,
      now,
    );
    assert.deepEqual(r.memory, { pct: 95, threshold: 90 });
    assert.deepEqual(r.disk, { pct: 95, threshold: 90 });
  });

  test("zero memory limit yields null memory pct", () => {
    const r = decideResourceAlert(
      snapshot({ memUsed: 95, memLimit: 0, diskUsed: 95, diskTotal: 100 }),
      thresholds,
      neverFired,
      Date.now(),
    );
    assert.equal(r.memory, null);
    assert.deepEqual(r.disk, { pct: 95, threshold: 90 });
  });

  test("zero disk total yields null disk pct", () => {
    const r = decideResourceAlert(
      snapshot({ memUsed: 95, memLimit: 100, diskUsed: 95, diskTotal: 0 }),
      thresholds,
      neverFired,
      Date.now(),
    );
    assert.deepEqual(r.memory, { pct: 95, threshold: 90 });
    assert.equal(r.disk, null);
  });

  test("equal to threshold fires (>=)", () => {
    const r = decideResourceAlert(
      snapshot({ memUsed: 90, memLimit: 100, diskUsed: 90, diskTotal: 100 }),
      thresholds,
      neverFired,
      Date.now(),
    );
    assert.deepEqual(r.memory, { pct: 90, threshold: 90 });
    assert.deepEqual(r.disk, { pct: 90, threshold: 90 });
  });
});
