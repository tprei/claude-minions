import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DoctorCheckName, FeatureFlag } from "@minions/shared";
import type { EngineContext } from "../context.js";
import {
  DOCTOR_CHECK_NAMES,
  DOCTOR_CHECKS,
  FEATURE_PROBES,
  computeFeatureSets,
  runDoctorChecks,
} from "./probes.js";

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

  it("memory-mcp is ready when the bridge script is present", async () => {
    const ctx = makeStubCtx();
    const result = await FEATURE_PROBES["memory-mcp"](ctx);
    assert.equal(result.ready, true);
  });
});

describe("runDoctorChecks", () => {
  const VALID_STATUSES = new Set(["ok", "degraded", "error"]);
  const ALL_CHECK_NAMES: DoctorCheckName[] = [
    "provider-auth",
    "github-auth",
    "repo-state",
    "worktree-health",
    "dependency-cache",
    "mcp-availability",
    "push-config",
    "sidecar-status",
  ];

  it("exports DOCTOR_CHECK_NAMES covering all 8 named checks", () => {
    assert.equal(DOCTOR_CHECK_NAMES.length, 8);
    for (const name of ALL_CHECK_NAMES) {
      assert.ok(DOCTOR_CHECK_NAMES.includes(name), `missing ${name}`);
    }
  });

  it("returns one DoctorCheck per named probe with valid status + ISO checkedAt", async () => {
    const ctx = makeStubCtx();
    const checks = await runDoctorChecks(ctx, {} as NodeJS.ProcessEnv);
    assert.equal(checks.length, 8);

    const seen = new Set<string>();
    for (const check of checks) {
      assert.ok(!seen.has(check.name), `duplicate check ${check.name}`);
      seen.add(check.name);
      assert.ok(VALID_STATUSES.has(check.status), `invalid status ${check.status} for ${check.name}`);
      assert.ok(typeof check.checkedAt === "string");
      assert.ok(!Number.isNaN(new Date(check.checkedAt).getTime()), `bad ISO for ${check.name}`);
    }
    for (const name of ALL_CHECK_NAMES) {
      assert.ok(seen.has(name), `missing ${name}`);
    }
  });

  it("provider-auth is ok for mock provider without ANTHROPIC_API_KEY", async () => {
    const ctx = makeStubCtx({
      env: { workspace: os.tmpdir(), provider: "mock" } as EngineContext["env"],
    });
    const out = await DOCTOR_CHECKS["provider-auth"](ctx, {} as NodeJS.ProcessEnv);
    assert.equal(out.status, "ok");
  });

  it("provider-auth is degraded when non-mock provider lacks ANTHROPIC_API_KEY", async () => {
    const ctx = makeStubCtx({
      env: { workspace: os.tmpdir(), provider: "anthropic" } as EngineContext["env"],
    });
    const out = await DOCTOR_CHECKS["provider-auth"](ctx, {} as NodeJS.ProcessEnv);
    assert.equal(out.status, "degraded");
    assert.match(out.detail ?? "", /ANTHROPIC_API_KEY/);
  });

  it("provider-auth is ok when ANTHROPIC_API_KEY is set", async () => {
    const ctx = makeStubCtx({
      env: { workspace: os.tmpdir(), provider: "anthropic" } as EngineContext["env"],
    });
    const out = await DOCTOR_CHECKS["provider-auth"](ctx, {
      ANTHROPIC_API_KEY: "sk-test",
    } as NodeJS.ProcessEnv);
    assert.equal(out.status, "ok");
  });

  it("github-auth is degraded when github subsystem disabled and no env tokens", async () => {
    const ctx = makeStubCtx();
    const out = await DOCTOR_CHECKS["github-auth"](ctx, {} as NodeJS.ProcessEnv);
    assert.equal(out.status, "degraded");
    assert.match(out.detail ?? "", /GITHUB_TOKEN|GH_TOKEN|GH_APP/);
  });

  it("github-auth is ok when github subsystem reports enabled", async () => {
    const ctx = makeStubCtx({
      github: {
        enabled: () => true,
        fetchPR: async () => {
          throw new Error("not used");
        },
      } as unknown as EngineContext["github"],
    });
    const out = await DOCTOR_CHECKS["github-auth"](ctx, {} as NodeJS.ProcessEnv);
    assert.equal(out.status, "ok");
  });

  it("repo-state is degraded when no repos are bound", async () => {
    const ctx = makeStubCtx({ repos: () => [] } as unknown as Partial<EngineContext>);
    const out = await DOCTOR_CHECKS["repo-state"](ctx, {} as NodeJS.ProcessEnv);
    assert.equal(out.status, "degraded");
  });

  it("repo-state is ok when at least one repo has a remote", async () => {
    const ctx = makeStubCtx({
      repos: () => [{ id: "r1", label: "r1", remote: "git@github.com:o/r.git" }],
    } as unknown as Partial<EngineContext>);
    const out = await DOCTOR_CHECKS["repo-state"](ctx, {} as NodeJS.ProcessEnv);
    assert.equal(out.status, "ok");
  });

  it("worktree-health is ok for a writable workspace", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-wt-"));
    try {
      const ctx = makeStubCtx({ env: { workspace } as EngineContext["env"] });
      const out = await DOCTOR_CHECKS["worktree-health"](ctx, {} as NodeJS.ProcessEnv);
      assert.equal(out.status, "ok");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("worktree-health is error when workspace is not configured", async () => {
    const ctx = makeStubCtx({ env: { workspace: "" } as EngineContext["env"] });
    const out = await DOCTOR_CHECKS["worktree-health"](ctx, {} as NodeJS.ProcessEnv);
    assert.equal(out.status, "error");
  });

  it("dependency-cache is degraded when .repos directory is missing", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-dc-"));
    try {
      const ctx = makeStubCtx({ env: { workspace } as EngineContext["env"] });
      const out = await DOCTOR_CHECKS["dependency-cache"](ctx, {} as NodeJS.ProcessEnv);
      assert.equal(out.status, "degraded");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("dependency-cache is ok when at least one v3-*-deps cache has node_modules", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-dc-"));
    try {
      const cacheDir = path.join(workspace, ".repos", "v3-foo-deps", "node_modules");
      fs.mkdirSync(cacheDir, { recursive: true });
      const ctx = makeStubCtx({ env: { workspace } as EngineContext["env"] });
      const out = await DOCTOR_CHECKS["dependency-cache"](ctx, {} as NodeJS.ProcessEnv);
      assert.equal(out.status, "ok");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("mcp-availability finds the bridge script", async () => {
    const ctx = makeStubCtx();
    const out = await DOCTOR_CHECKS["mcp-availability"](ctx, {} as NodeJS.ProcessEnv);
    assert.equal(out.status, "ok");
  });

  it("push-config is degraded when GitHub App env vars are missing", async () => {
    const ctx = makeStubCtx();
    const out = await DOCTOR_CHECKS["push-config"](ctx, {} as NodeJS.ProcessEnv);
    assert.equal(out.status, "degraded");
  });

  it("push-config is ok when GitHub App is fully configured", async () => {
    const ctx = makeStubCtx({
      env: {
        workspace: os.tmpdir(),
        githubApp: { id: "1", privateKey: "pk", installationId: "42" },
      } as EngineContext["env"],
    });
    const out = await DOCTOR_CHECKS["push-config"](ctx, {} as NodeJS.ProcessEnv);
    assert.equal(out.status, "ok");
  });

  it("sidecar-status is degraded when no pidfile exists", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-sc-"));
    try {
      const ctx = makeStubCtx({ env: { workspace } as EngineContext["env"] });
      const out = await DOCTOR_CHECKS["sidecar-status"](ctx, {} as NodeJS.ProcessEnv);
      assert.equal(out.status, "degraded");
      assert.match(out.detail ?? "", /sidecar/i);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("sidecar-status is ok when pidfile points at the current process", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-sc-"));
    try {
      fs.writeFileSync(path.join(workspace, ".sidecar.pid"), String(process.pid));
      const ctx = makeStubCtx({ env: { workspace } as EngineContext["env"] });
      const out = await DOCTOR_CHECKS["sidecar-status"](ctx, {} as NodeJS.ProcessEnv);
      assert.equal(out.status, "ok");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
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
