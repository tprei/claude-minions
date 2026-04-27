import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FeatureFlag } from "@minions/shared";
import type { EngineContext } from "../context.js";
import { FEATURE_PROBES, computeFeatureSets } from "./probes.js";

const ALL_FLAGS: FeatureFlag[] = [
  "sessions",
  "dags",
  "ship",
  "loops",
  "variants",
  "judge",
  "checkpoints",
  "memory",
  "memory-mcp",
  "audit",
  "resources",
  "push",
  "external-tasks",
  "runtime-overrides",
  "github",
  "quality-gates",
  "readiness",
  "ci-babysit",
  "screenshots",
  "diff",
  "pr-preview",
  "stack",
  "split",
  "voice-input",
];

function makeStubCtx(overrides: Partial<EngineContext> = {}): EngineContext {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "probes-test-"));
  const sessions = {
    checkpoints: () => [],
  } as unknown as EngineContext["sessions"];
  const variants = {
    judge: async () => undefined,
  } as unknown as EngineContext["variants"];
  const memory = {
    list: () => [],
  } as unknown as EngineContext["memory"];
  const github = {
    enabled: () => false,
    fetchPR: async () => {
      throw new Error("not used");
    },
  } as unknown as EngineContext["github"];

  const base = {
    env: { workspace } as EngineContext["env"],
    sessions,
    dags: {} as EngineContext["dags"],
    ship: {} as EngineContext["ship"],
    loops: {} as EngineContext["loops"],
    variants,
    memory,
    audit: {} as EngineContext["audit"],
    resource: {} as EngineContext["resource"],
    push: {} as EngineContext["push"],
    intake: {} as EngineContext["intake"],
    runtime: {} as EngineContext["runtime"],
    github,
    quality: {} as EngineContext["quality"],
    readiness: {} as EngineContext["readiness"],
    ci: {} as EngineContext["ci"],
    landing: {} as EngineContext["landing"],
  } as unknown as EngineContext;

  return { ...base, ...overrides } as EngineContext;
}

describe("computeFeatureSets", () => {
  it("returns disjoint ready and pending sets covering every FeatureFlag", async () => {
    const ctx = makeStubCtx();
    const { ready, pending } = await computeFeatureSets(ctx);

    const allReturned = [...ready, ...pending.map((p) => p.flag)];
    assert.equal(allReturned.length, ALL_FLAGS.length, "ready+pending count must equal flag count");

    const seen = new Set<FeatureFlag>();
    for (const flag of allReturned) {
      assert.ok(!seen.has(flag), `flag ${flag} appeared in both sets or duplicated`);
      seen.add(flag);
    }
    for (const flag of ALL_FLAGS) {
      assert.ok(seen.has(flag), `flag ${flag} missing from probe output`);
    }

    for (const entry of pending) {
      assert.ok(
        typeof entry.reason === "string" && entry.reason.length > 0,
        `pending flag ${entry.flag} must have a non-empty reason`,
      );
    }
  });

  it("places memory in pending with a reason when memory subsystem is null", async () => {
    const ctx = makeStubCtx({ memory: null as unknown as EngineContext["memory"] });
    const { ready, pending } = await computeFeatureSets(ctx);
    assert.ok(!ready.includes("memory"), "memory should not be ready when subsystem is null");
    const memEntry = pending.find((p) => p.flag === "memory");
    assert.ok(memEntry, "memory should appear in pending");
    assert.match(memEntry!.reason, /memory subsystem not wired/);
  });

  it("memory-mcp is always pending until provider spawn wires it", async () => {
    const ctx = makeStubCtx();
    const result = await FEATURE_PROBES["memory-mcp"](ctx);
    assert.equal(result.ready, false);
    if (!result.ready) {
      assert.match(result.reason, /memory MCP not yet wired/);
    }
  });
});

describe("screenshots probe", () => {
  it("returns ready:false when workspace is missing", async () => {
    const ctx = makeStubCtx({
      env: { workspace: "" } as EngineContext["env"],
    });
    const result = await FEATURE_PROBES["screenshots"](ctx);
    assert.equal(result.ready, false);
    if (!result.ready) {
      assert.ok(result.reason.length > 0);
    }
  });

  it("returns ready:false when workspace path is not a directory", async () => {
    const tmpFile = path.join(os.tmpdir(), `probes-not-a-dir-${Date.now()}`);
    fs.writeFileSync(tmpFile, "x");
    try {
      const ctx = makeStubCtx({
        env: { workspace: tmpFile } as EngineContext["env"],
      });
      const result = await FEATURE_PROBES["screenshots"](ctx);
      assert.equal(result.ready, false);
      if (!result.ready) {
        assert.match(result.reason, /screenshots dir not writable/);
      }
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });
});
