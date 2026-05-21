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
  it("composes docker exec argv with workdir and command argv", async () => {
    const host = new CapturingRunner();
    const docker = new DockerCommandRunner(["docker", "exec", "ctr"], host);

    await docker.run({ cwd: "/workspace/app", argv: ["npm", "test"] });

    expect(host.lastOpts).toBeDefined();
    expect(host.lastOpts!.argv).toEqual(["docker", "exec", "--workdir", "/workspace/app", "ctr", "npm", "test"]);
  });

  it("preserves spaces in cwd and argument boundaries", async () => {
    const host = new CapturingRunner();
    const docker = new DockerCommandRunner(["docker", "exec", "ctr"], host);

    await docker.run({ cwd: "/path with spaces", argv: ["npm", "run", "test:unit"] });

    expect(host.lastOpts!.argv).toEqual(["docker", "exec", "--workdir", "/path with spaces", "ctr", "npm", "run", "test:unit"]);
  });

  it("forwards timeoutMs and signal", async () => {
    const host = new CapturingRunner();
    const docker = new DockerCommandRunner(["docker", "exec", "ctr"], host);

    const ctrl = new AbortController();
    await docker.run({ cwd: "/app", argv: ["test"], timeoutMs: 5000, signal: ctrl.signal });

    expect(host.lastOpts!.timeoutMs).toBe(5000);
    expect(host.lastOpts!.signal).toBe(ctrl.signal);
  });

  it("forwards env as docker exec flags", async () => {
    const host = new CapturingRunner();
    const docker = new DockerCommandRunner(["docker", "exec", "ctr"], host);

    await docker.run({ cwd: "/app", argv: ["test"], env: { MY: "val" } });

    expect(host.lastOpts!.argv).toEqual(["docker", "exec", "--env", "MY=val", "--workdir", "/app", "ctr", "test"]);
    expect(host.lastOpts!.env).toBeUndefined();
  });

  it("omits timeoutMs and signal when not provided", async () => {
    const host = new CapturingRunner();
    const docker = new DockerCommandRunner(["docker", "exec", "ctr"], host);

    await docker.run({ cwd: "/app", argv: ["test"] });

    expect(host.lastOpts).toBeDefined();
    expect(host.lastOpts!.timeoutMs).toBeUndefined();
    expect(host.lastOpts!.signal).toBeUndefined();
  });

  it("passes through the host runner result", async () => {
    const runnerSpy = vi.fn().mockResolvedValue(
      { exitCode: 0, stdout: "ok", stderr: "", timedOut: false } satisfies CommandRunResult,
    );
    const hostSpy: CommandRunner = { run: runnerSpy };
    const docker = new DockerCommandRunner(["docker", "exec", "ctr"], hostSpy);

    const result = await docker.run({ cwd: "/tmp", argv: ["echo", "hello"] });

    expect(result.exitCode).toBe(0);
    expect(runnerSpy).toHaveBeenCalledOnce();
  });
});
