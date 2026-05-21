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

function commandString(opts: CommandRunOptions): string {
  return opts.argv.join(" ");
}

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

  it("rejects shell metacharacters in command strings", async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify([{ name: "lint", command: "pnpm lint; touch /tmp/pwned" }]),
    );
    const plugin = new ExecQualityPlugin(makeRunner());
    await expect(plugin.loadConfig("/workspace")).rejects.toThrow(/unsupported shell metacharacter/);
  });

  it("rejects cwdRel values that escape the workspace", async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify([{ name: "lint", command: "pnpm lint", cwdRel: "../outside" }]),
    );
    const plugin = new ExecQualityPlugin(makeRunner());
    await expect(plugin.loadConfig("/workspace")).rejects.toThrow(/escapes workspace/);
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
      if (commandString(opts) === "npm run lint") {
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
      if (commandString(opts) === "npm run lint") {
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

  it("runs checks serially in config order", async () => {
    let running = 0;
    let maxConcurrent = 0;
    const started: string[] = [];
    const runner = makeRunner(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      started.push(String.fromCharCode(96 + started.length + 1));
      await new Promise((r) => setTimeout(r, 10));
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
    await plugin.run(configs, "/workspace", {});
    expect(maxConcurrent).toBe(1);
    expect(started).toEqual(["a", "b", "c", "d"]);
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

  it("parses quoted command strings into argv without a shell", async () => {
    const runner = makeRunner();
    const plugin = new ExecQualityPlugin(runner);
    await plugin.run([{ name: "smoke", command: "node -e \"process.exit(0)\"" }], "/workspace", {});
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace",
      argv: ["node", "-e", "process.exit(0)"],
    }));
  });

  it("rejects shell metacharacters before invoking the runner", async () => {
    const runner = makeRunner();
    const plugin = new ExecQualityPlugin(runner);
    await expect(
      plugin.run([{ name: "smoke", command: "node -e \"process.exit(0)\"; touch /tmp/pwned" }], "/workspace", {}),
    ).rejects.toThrow(/unsupported shell metacharacter/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rejects cwdRel values that resolve outside the workspace", async () => {
    const runner = makeRunner();
    const plugin = new ExecQualityPlugin(runner);
    await expect(
      plugin.run([{ name: "smoke", command: "pnpm test", cwdRel: "../outside" }], "/workspace", {}),
    ).rejects.toThrow(/escapes workspace/);
    expect(runner.run).not.toHaveBeenCalled();
  });
});
