import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DockerFs } from "../../../src/plugins/workspace/workspace-fs.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    queueMicrotask(() => proc.emit("close", 0));
    return proc;
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DockerFs", () => {
  it("passes paths as argv without shell evaluation", async () => {
    const { spawn } = await import("node:child_process");
    const fs = new DockerFs(["docker", "exec", "worker"]);

    await expect(fs.pathExists("$(touch /tmp/pwned)")).resolves.toBe(true);

    expect(spawn).toHaveBeenCalledWith("docker", [
      "exec",
      "worker",
      "test",
      "-e",
      "$(touch /tmp/pwned)",
    ]);
  });

  it("removes directories without sh -c", async () => {
    const { spawn } = await import("node:child_process");
    const fs = new DockerFs(["docker", "exec", "worker"]);

    await fs.removeRecursive("/workspace/repo; touch /tmp/pwned");

    expect(spawn).toHaveBeenCalledWith("docker", [
      "exec",
      "worker",
      "rm",
      "-rf",
      "--",
      "/workspace/repo; touch /tmp/pwned",
    ]);
  });
});
