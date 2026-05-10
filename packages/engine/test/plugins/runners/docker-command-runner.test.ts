import { describe, expect, it, vi } from "vitest";
import { DockerCommandRunner } from "../../../src/plugins/runners/docker-command-runner.js";
import type { CommandRunner, CommandRunResult, CommandRunOptions } from "../../../src/plugins/command-runner.js";

class CapturingRunner implements CommandRunner {
  lastOpts: CommandRunOptions | undefined = undefined;

  run(opts: CommandRunOptions): Promise<CommandRunResult> {
    this.lastOpts = opts;
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  }
}

describe("DockerCommandRunner", () => {
  it("composes command with prefix + sh -c wrapping", async () => {
    const host = new CapturingRunner();
    const docker = new DockerCommandRunner(["docker", "exec", "ctr"], host);

    await docker.run({ cwd: "/workspace/app", command: "npm test" });

    expect(host.lastOpts).toBeDefined();
    expect(host.lastOpts!.command).toContain("docker");
    expect(host.lastOpts!.command).toContain("exec");
    expect(host.lastOpts!.command).toContain("ctr");
    expect(host.lastOpts!.command).toContain("sh");
    expect(host.lastOpts!.command).toContain("/workspace/app");
    expect(host.lastOpts!.command).toContain("npm test");
  });

  it("composed command uses sh -c inner and shell-quoting", async () => {
    const host = new CapturingRunner();
    const docker = new DockerCommandRunner(["docker", "exec", "ctr"], host);

    await docker.run({ cwd: "/path with spaces", command: "npm test" });

    expect(host.lastOpts!.command).toContain("sh");
    expect(host.lastOpts!.command).toContain("-c");
    expect(host.lastOpts!.command).toContain("npm test");
  });

  it("forwards timeoutMs and signal", async () => {
    const host = new CapturingRunner();
    const docker = new DockerCommandRunner(["docker", "exec", "ctr"], host);

    const ctrl = new AbortController();
    await docker.run({ cwd: "/app", command: "test", timeoutMs: 5000, signal: ctrl.signal });

    expect(host.lastOpts!.timeoutMs).toBe(5000);
    expect(host.lastOpts!.signal).toBe(ctrl.signal);
  });

  it("forwards env", async () => {
    const host = new CapturingRunner();
    const docker = new DockerCommandRunner(["docker", "exec", "ctr"], host);

    await docker.run({ cwd: "/app", command: "test", env: { MY: "val" } });

    expect(host.lastOpts!.env).toEqual({ MY: "val" });
  });

  it("omits timeoutMs and signal when not provided", async () => {
    const host = new CapturingRunner();
    const docker = new DockerCommandRunner(["docker", "exec", "ctr"], host);

    await docker.run({ cwd: "/app", command: "test" });

    expect(host.lastOpts).toBeDefined();
    expect(host.lastOpts!.timeoutMs).toBeUndefined();
    expect(host.lastOpts!.signal).toBeUndefined();
  });

  it("uses real host runner: sh -c wrapping passes through to local sh", async () => {
    const runnerSpy = vi.fn().mockResolvedValue(
      { exitCode: 0, stdout: "ok", stderr: "", timedOut: false } satisfies CommandRunResult,
    );
    const hostSpy: CommandRunner = { run: runnerSpy };
    const docker = new DockerCommandRunner(["sh", "-c"], hostSpy);

    const result = await docker.run({ cwd: "/tmp", command: "echo hello" });

    expect(result.exitCode).toBe(0);
    expect(runnerSpy).toHaveBeenCalledOnce();
  });
});
