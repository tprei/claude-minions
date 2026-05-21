import { describe, expect, it } from "vitest";
import { HostCommandRunner } from "../../../src/plugins/runners/host-command-runner.js";

const runner = new HostCommandRunner();

describe("HostCommandRunner", () => {
  it("exit 0: exitCode=0, timedOut=false, captures stdout/stderr", async () => {
    const result = await runner.run({
      cwd: "/tmp",
      argv: [process.execPath, "-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(0)"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  it("non-zero exit: exitCode matches, timedOut=false", async () => {
    const result = await runner.run({
      cwd: "/tmp",
      argv: [process.execPath, "-e", "process.exit(2)"],
    });
    expect(result.exitCode).toBe(2);
    expect(result.timedOut).toBe(false);
  });

  it("timeout kills child: timedOut=true, exitCode=-1", async () => {
    const result = await runner.run({
      cwd: "/tmp",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
  }, 5000);

  it("abort signal kills child", async () => {
    const ctrl = new AbortController();
    const resultPromise = runner.run({
      cwd: "/tmp",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 100);
    const result = await resultPromise;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
  }, 5000);

  it("env override is forwarded to child process", async () => {
    const result = await runner.run({
      cwd: "/tmp",
      argv: [process.execPath, "-e", "process.stdout.write(process.env.MY_VAR || 'none')"],
      env: { MY_VAR: "hello" },
    });
    expect(result.stdout).toBe("hello");
  });

  it("stdout and stderr are captured separately", async () => {
    const result = await runner.run({
      cwd: "/tmp",
      argv: [process.execPath, "-e", "process.stdout.write('STDOUT'); process.stderr.write('STDERR'); process.exit(1)"],
    });
    expect(result.stdout).toBe("STDOUT");
    expect(result.stderr).toBe("STDERR");
    expect(result.exitCode).not.toBe(0);
  });

  it("passes shell metacharacters as literal argv data", async () => {
    const result = await runner.run({
      cwd: "/tmp",
      argv: [process.execPath, "-e", "process.stdout.write(process.argv[1] || '')", "a;b&&c|d>e"],
    });
    expect(result.stdout).toBe("a;b&&c|d>e");
    expect(result.exitCode).toBe(0);
  });
});
