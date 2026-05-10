import { describe, expect, it, vi, beforeEach } from "vitest";
import { ExecQualityPlugin } from "../../../src/plugins/quality/exec-quality-plugin.js";
import type { CommandRunner, CommandRunResult, CommandRunOptions } from "../../../src/plugins/command-runner.js";
import type { QualityGateConfig } from "../../../src/plugins/quality-plugin.js";
import * as fsp from "node:fs/promises";
import { createLogger } from "../../../src/observability/logger.js";
import type { Sink } from "../../../src/observability/sinks.js";
import type { LogRecord } from "../../../src/observability/types.js";

function makeCapturingSink(): { sink: Sink; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { sink: { write: (r) => { records.push(r); } }, records };
}

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

function makeRunner(
  fn?: (opts: CommandRunOptions) => Promise<CommandRunResult>,
): CommandRunner {
  return {
    run: vi.fn().mockImplementation(
      fn ?? (() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false })),
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ExecQualityPlugin — loadConfig", () => {
  it("returns [] when file is absent", async () => {
    vi.mocked(fsp.readFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const plugin = new ExecQualityPlugin(makeRunner());
    const result = await plugin.loadConfig("/workspace");
    expect(result).toEqual([]);
  });

  it("parses valid JSON array", async () => {
    const configs: QualityGateConfig[] = [
      { name: "lint", command: "npm run lint" },
      { name: "test", command: "npm test", required: false },
    ];
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(configs));
    const plugin = new ExecQualityPlugin(makeRunner());
    const result = await plugin.loadConfig("/workspace");
    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe("lint");
    expect(result[1]?.required).toBe(false);
  });

  it("skips invalid entries with a warning", async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify([
        { name: "lint", command: "npm run lint" },
        { name: 42, command: "bad" },
        "not-an-object",
      ]),
    );
    const { sink, records } = makeCapturingSink();
    const plugin = new ExecQualityPlugin(makeRunner(), createLogger("debug", [sink]));
    const result = await plugin.loadConfig("/workspace");
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("lint");
    expect(records.some((r) => r.lvl === "warn")).toBe(true);
  });

  it("throws on malformed JSON", async () => {
    vi.mocked(fsp.readFile).mockResolvedValue("{ bad json");
    const plugin = new ExecQualityPlugin(makeRunner());
    await expect(plugin.loadConfig("/workspace")).rejects.toThrow();
  });

  it("returns [] with warning when root is not an array", async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ name: "lint" }));
    const { sink, records } = makeCapturingSink();
    const plugin = new ExecQualityPlugin(makeRunner(), createLogger("debug", [sink]));
    const result = await plugin.loadConfig("/workspace");
    expect(result).toEqual([]);
    expect(records.some((r) => r.lvl === "warn")).toBe(true);
  });
});

describe("ExecQualityPlugin — run", () => {
  it("all pass: status=passed", async () => {
    const runner = makeRunner();
    const plugin = new ExecQualityPlugin(runner);
    const configs: QualityGateConfig[] = [
      { name: "lint", command: "npm run lint" },
      { name: "test", command: "npm test" },
    ];
    const result = await plugin.run(configs, "/workspace", {});
    expect(result.status).toBe("passed");
    expect(result.checks).toHaveLength(2);
    expect(result.checks.every((c) => c.status === "passed")).toBe(true);
  });

  it("required failure: status=failed", async () => {
    const runner = makeRunner(async (opts) => {
      if (opts.command === "npm run lint") {
        return { exitCode: 1, stdout: "", stderr: "lint error", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });
    const plugin = new ExecQualityPlugin(runner);
    const configs: QualityGateConfig[] = [
      { name: "lint", command: "npm run lint", required: true },
      { name: "test", command: "npm test" },
    ];
    const result = await plugin.run(configs, "/workspace", {});
    expect(result.status).toBe("failed");
    const lint = result.checks.find((c) => c.name === "lint");
    expect(lint?.status).toBe("failed");
    expect(lint?.exitCode).not.toBe(0);
  });

  it("non-required failure only: status=partial", async () => {
    const runner = makeRunner(async (opts) => {
      if (opts.command === "npm run lint") {
        return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });
    const plugin = new ExecQualityPlugin(runner);
    const configs: QualityGateConfig[] = [
      { name: "lint", command: "npm run lint", required: false },
      { name: "test", command: "npm test" },
    ];
    const result = await plugin.run(configs, "/workspace", {});
    expect(result.status).toBe("partial");
  });

  it("timeout: exitCode=-1, status=failed for required check", async () => {
    const runner = makeRunner(async () => {
      return { exitCode: -1, stdout: "", stderr: "timed out", timedOut: true };
    });
    const plugin = new ExecQualityPlugin(runner);
    const configs: QualityGateConfig[] = [{ name: "test", command: "npm test", timeoutMs: 100 }];
    const result = await plugin.run(configs, "/workspace", {});
    expect(result.status).toBe("failed");
    expect(result.checks[0]?.exitCode).toBe(-1);
  });

  it("pLimit(2): 4 checks * 100ms delay take ~200ms not ~400ms", async () => {
    let running = 0;
    let maxConcurrent = 0;
    const runner = makeRunner(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 100));
      running--;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });
    const plugin = new ExecQualityPlugin(runner);
    const configs: QualityGateConfig[] = [
      { name: "a", command: "a" },
      { name: "b", command: "b" },
      { name: "c", command: "c" },
      { name: "d", command: "d" },
    ];
    const t0 = Date.now();
    await plugin.run(configs, "/workspace", {});
    const elapsed = Date.now() - t0;
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(elapsed).toBeLessThan(350);
    expect(elapsed).toBeGreaterThan(150);
  }, 5000);

  it("tail truncation: long stdout is trimmed to 4096 chars", async () => {
    const longOut = "x".repeat(10000);
    const runner = makeRunner(async () => {
      return { exitCode: 0, stdout: longOut, stderr: "", timedOut: false };
    });
    const plugin = new ExecQualityPlugin(runner);
    const configs: QualityGateConfig[] = [{ name: "test", command: "t" }];
    const result = await plugin.run(configs, "/workspace", {});
    expect(result.checks[0]?.stdoutTail).toHaveLength(4096);
    expect(result.checks[0]?.stdoutTail).toBe(longOut.slice(longOut.length - 4096));
  });

  it("abort mid-run: plugin.run rejects when runner rejects on abort", async () => {
    const ctrl = new AbortController();
    const runner = makeRunner(async (opts) => {
      return new Promise<CommandRunResult>((_resolve, reject) => {
        if (opts.signal?.aborted) { reject(new Error("aborted")); return; }
        opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const plugin = new ExecQualityPlugin(runner);
    const configs: QualityGateConfig[] = [{ name: "test", command: "long" }];
    const runPromise = plugin.run(configs, "/workspace", { signal: ctrl.signal });
    ctrl.abort();
    await expect(runPromise).rejects.toThrow("aborted");
  });
});
