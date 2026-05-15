import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import { buildDoctorReport, defaultPiAuthProbe, defaultPiVersionProbe } from "../../src/engine.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { StubWorkspaceBackend } from "../../src/plugins/workspace/stub-workspace.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: vi.fn(),
  };
});

function baseInput() {
  const repo = new InMemoryWorkflowRepository();
  const runtime = new StubRuntimeBackend();
  const workspace = new StubWorkspaceBackend();
  return {
    repo,
    runtime,
    workspace,
    dbPath: "/tmp/doctor-pi.db",
    dataDir: "/tmp/doctor-pi-data",
    githubEnabled: false,
    githubTokenPresent: false,
    pushEnabled: false,
    now: () => "2026-05-15T00:00:00.000Z",
  } as const;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildDoctorReport pi-check gating", () => {
  it("omits pi checks when provider is undefined", async () => {
    const report = await buildDoctorReport({ ...baseInput() });
    const names = report.checks.map((c) => c.name);
    expect(names).not.toContain("pi-version");
    expect(names).not.toContain("pi-auth");
  });

  it("omits pi checks for claude-code provider", async () => {
    const report = await buildDoctorReport({ ...baseInput(), providerName: "claude-code" });
    const names = report.checks.map((c) => c.name);
    expect(names).not.toContain("pi-version");
    expect(names).not.toContain("pi-auth");
  });

  it("omits pi checks for codex provider", async () => {
    const report = await buildDoctorReport({ ...baseInput(), providerName: "codex" });
    const names = report.checks.map((c) => c.name);
    expect(names).not.toContain("pi-version");
    expect(names).not.toContain("pi-auth");
  });

  it("omits pi checks for stub provider", async () => {
    const report = await buildDoctorReport({ ...baseInput(), providerName: "stub" });
    const names = report.checks.map((c) => c.name);
    expect(names).not.toContain("pi-version");
    expect(names).not.toContain("pi-auth");
  });

  it("emits both pi checks when provider is pi", async () => {
    const report = await buildDoctorReport({
      ...baseInput(),
      providerName: "pi",
      piVersionProbe: async () => ({ status: "ok", detail: "0.70.1" }),
      piAuthProbe: async () => ({ status: "ok", detail: "chatgpt-codex" }),
    });
    const version = report.checks.find((c) => c.name === "pi-version");
    const auth = report.checks.find((c) => c.name === "pi-auth");
    expect(version).toMatchObject({ status: "ok", detail: "0.70.1" });
    expect(auth).toMatchObject({ status: "ok", detail: "chatgpt-codex" });
  });

  it("propagates pi-version error when probe says pi is not on PATH", async () => {
    const report = await buildDoctorReport({
      ...baseInput(),
      providerName: "pi",
      piVersionProbe: async () => ({ status: "error", detail: "pi not on PATH" }),
      piAuthProbe: async () => ({ status: "ok", detail: "chatgpt-codex" }),
    });
    expect(report.checks.find((c) => c.name === "pi-version")).toMatchObject({
      status: "error",
      detail: "pi not on PATH",
    });
  });

  it("propagates pi-version degraded when probe reports an old version", async () => {
    const report = await buildDoctorReport({
      ...baseInput(),
      providerName: "pi",
      piVersionProbe: async () => ({ status: "degraded", detail: "0.69.9" }),
      piAuthProbe: async () => ({ status: "ok", detail: "chatgpt-codex" }),
    });
    expect(report.checks.find((c) => c.name === "pi-version")).toMatchObject({
      status: "degraded",
      detail: "0.69.9",
    });
  });

  it("treats a thrown probe as an error check rather than crashing the report", async () => {
    const report = await buildDoctorReport({
      ...baseInput(),
      providerName: "pi",
      piVersionProbe: async () => { throw new Error("boom"); },
      piAuthProbe: async () => ({ status: "ok", detail: "chatgpt-codex" }),
    });
    expect(report.checks.find((c) => c.name === "pi-version")).toMatchObject({
      status: "error",
      detail: "boom",
    });
  });
});

describe("defaultPiAuthProbe", () => {
  it("returns error when auth.json is missing", async () => {
    vi.mocked(fsp.readFile).mockRejectedValueOnce(
      Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }),
    );
    expect(await defaultPiAuthProbe()).toEqual({ status: "error", detail: "no auth.json" });
  });

  it("returns degraded when auth.json is present but has no codex subscription", async () => {
    vi.mocked(fsp.readFile).mockResolvedValueOnce(
      JSON.stringify({ "anthropic-claude": { type: "oauth" } }),
    );
    expect(await defaultPiAuthProbe()).toEqual({ status: "degraded", detail: "no codex subscription" });
  });

  it("returns degraded for unparseable auth.json (file present but unusable)", async () => {
    vi.mocked(fsp.readFile).mockResolvedValueOnce("{ not json secret-must-not-leak");
    const result = await defaultPiAuthProbe();
    expect(result.status).toBe("degraded");
    expect(result.detail).toBe("auth.json parse error");
    expect(result.detail).not.toContain("secret-must-not-leak");
  });

  it("returns ok when codex oauth subscription is present, without leaking the token", async () => {
    vi.mocked(fsp.readFile).mockResolvedValueOnce(
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access_token: "sk-super-secret-must-not-leak",
          refresh_token: "rt-super-secret",
        },
      }),
    );
    const result = await defaultPiAuthProbe();
    expect(result).toEqual({ status: "ok", detail: "chatgpt-codex" });
    expect(JSON.stringify(result)).not.toContain("sk-super-secret-must-not-leak");
    expect(JSON.stringify(result)).not.toContain("rt-super-secret");
  });

  it("returns ok when codex subscription type entry is present", async () => {
    vi.mocked(fsp.readFile).mockResolvedValueOnce(
      JSON.stringify({ "openai-codex": { type: "subscription" } }),
    );
    expect(await defaultPiAuthProbe()).toEqual({ status: "ok", detail: "chatgpt-codex" });
  });
});

describe("defaultPiVersionProbe", () => {
  const savedPath = process.env["PATH"];
  afterEach(() => {
    if (savedPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = savedPath;
  });

  it("returns error when pi binary is not on PATH", async () => {
    process.env["PATH"] = "/nonexistent-doctor-test-path";
    const result = await defaultPiVersionProbe();
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/pi not on PATH|ENOENT/);
  });
});
