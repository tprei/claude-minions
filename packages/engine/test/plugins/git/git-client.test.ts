import { EventEmitter } from "node:events";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitClient, GitError } from "../../../src/plugins/git/git-client.js";

vi.mock("node:child_process");

const DISABLED_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";
const DISABLED_HOOKS_ARGS = ["-c", `core.hooksPath=${DISABLED_HOOKS_PATH}`];

interface MockProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: Mock;
}

function makeMockProc(stdoutData: string, stderrData: string, exitCode: number): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();

  setImmediate(() => {
    proc.stdout.emit("data", Buffer.from(stdoutData));
    proc.stderr.emit("data", Buffer.from(stderrData));
    proc.emit("close", exitCode);
  });

  return proc;
}

function makeHangingProc(): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn(() => {
    proc.emit("close", null);
    return true;
  });
  return proc;
}

function patchEnv(entries: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

let spawnMock: Mock;

beforeEach(async () => {
  const cp = await import("node:child_process");
  spawnMock = cp.spawn as unknown as Mock;
  spawnMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GitClient", () => {
  describe("worktreeAdd", () => {
    it("resetBranch: true uses -B flag with HEAD", async () => {
      const client = new GitClient();
      spawnMock.mockReturnValue(makeMockProc("", "", 0));

      await client.worktreeAdd("/repo", {
        path: "/workspace/wf_task",
        branch: "minions/wf_task",
        resetBranch: true,
      });

      const call = spawnMock.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }];
      expect(call[0]).toBe("git");
      expect(call[1]).toEqual([...DISABLED_HOOKS_ARGS, "worktree", "add", "-B", "minions/wf_task", "/workspace/wf_task", "HEAD"]);
      expect(call[2]).toEqual(expect.objectContaining({ cwd: "/repo", env: expect.any(Object) }));
    });

    it("resetBranch: true with baseRef uses -B flag with baseRef", async () => {
      const client = new GitClient();
      spawnMock.mockReturnValue(makeMockProc("", "", 0));

      await client.worktreeAdd("/repo", {
        path: "/workspace/wf_task",
        branch: "minions/wf_task",
        baseRef: "main",
        resetBranch: true,
      });

      const call = spawnMock.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }];
      expect(call[0]).toBe("git");
      expect(call[1]).toEqual([...DISABLED_HOOKS_ARGS, "worktree", "add", "-B", "minions/wf_task", "/workspace/wf_task", "main"]);
      expect(call[2]).toEqual(expect.objectContaining({ cwd: "/repo", env: expect.any(Object) }));
    });

    it("resetBranch: false, branch not yet existing — uses -b flag", async () => {
      const client = new GitClient();
      // first call: branchExists (rev-parse) → exits non-zero = branch doesn't exist
      // second call: worktree add -b
      spawnMock
        .mockReturnValueOnce(makeMockProc("", "unknown revision", 128))
        .mockReturnValueOnce(makeMockProc("", "", 0));

      await client.worktreeAdd("/repo", {
        path: "/workspace/wf_task",
        branch: "minions/wf_task",
        resetBranch: false,
      });

      const calls = spawnMock.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual([
        "git",
        [...DISABLED_HOOKS_ARGS, "worktree", "add", "-b", "minions/wf_task", "/workspace/wf_task", "HEAD"],
        expect.objectContaining({ cwd: "/repo", env: expect.any(Object) }),
      ]);
    });

    it("resetBranch: false, branch existing — checks out existing branch without -b/-B", async () => {
      const client = new GitClient();
      // first call: branchExists (rev-parse) → exits zero = branch exists
      // second call: worktree add (no -b)
      spawnMock
        .mockReturnValueOnce(makeMockProc("abc123\n", "", 0))
        .mockReturnValueOnce(makeMockProc("", "", 0));

      await client.worktreeAdd("/repo", {
        path: "/workspace/wf_task",
        branch: "minions/wf_task",
        resetBranch: false,
      });

      const calls = spawnMock.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual([
        "git",
        [...DISABLED_HOOKS_ARGS, "worktree", "add", "/workspace/wf_task", "minions/wf_task"],
        expect.objectContaining({ cwd: "/repo", env: expect.any(Object) }),
      ]);
    });
  });

  describe("commandPrefix", () => {
    it("prepends commandPrefix before git and its args", async () => {
      const client = new GitClient({ commandPrefix: ["docker", "exec", "worker"] });
      spawnMock.mockReturnValue(makeMockProc("", "", 0));

      await client.worktreePrune("/repo");

      const call = spawnMock.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }];
      expect(call[0]).toBe("docker");
      expect(call[1]).toEqual(["exec", "worker", "git", ...DISABLED_HOOKS_ARGS, "worktree", "prune"]);
      expect(call[2]).toEqual(expect.objectContaining({ cwd: "/repo", env: expect.any(Object) }));
    });
  });

  describe("run env option", () => {
    it("does not propagate parent secrets by default while preserving safe variables", async () => {
      const client = new GitClient();
      spawnMock.mockReturnValue(makeMockProc("", "", 0));
      const restoreEnv = patchEnv({
        PATH: "/test/bin",
        HOME: "/test/home",
        GIT_AUTHOR_NAME: "Minions Bot",
        GIT_AUTHOR_EMAIL: "bot@example.com",
        SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
        GIT_SSH_COMMAND: "ssh -i /tmp/id_ed25519",
        AWS_SECRET_ACCESS_KEY: "top-secret",
      });

      try {
        await client.run("/repo", ["status"]);
      } finally {
        restoreEnv();
      }

      const call = spawnMock.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }];
      expect(call[1]).toEqual([...DISABLED_HOOKS_ARGS, "status"]);
      expect(call[2].env).toBeDefined();
      expect(call[2].env["PATH"]).toBe("/test/bin");
      expect(call[2].env["HOME"]).toBe("/test/home");
      expect(call[2].env["GIT_AUTHOR_NAME"]).toBe("Minions Bot");
      expect(call[2].env["GIT_AUTHOR_EMAIL"]).toBe("bot@example.com");
      expect(call[2].env["SSH_AUTH_SOCK"]).toBe("/tmp/ssh-agent.sock");
      expect(call[2].env["GIT_SSH_COMMAND"]).toBe("ssh -i /tmp/id_ed25519");
      expect(call[2].env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    });

    it("passes opts.env alongside the sanitized environment", async () => {
      const client = new GitClient();
      spawnMock.mockReturnValue(makeMockProc("", "", 0));
      const restoreEnv = patchEnv({
        PATH: "/test/bin",
        HOME: "/test/home",
        GITHUB_TOKEN: "host-token",
      });

      try {
        await client.run("/repo", ["status"], { env: { FOO: "bar", GIT_ASKPASS: "/scripts/askpass.sh", GH_TOKEN: "scoped-token" } });
      } finally {
        restoreEnv();
      }

      const call = spawnMock.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }];
      expect(call[2].env["PATH"]).toBe("/test/bin");
      expect(call[2].env["HOME"]).toBe("/test/home");
      expect(call[2].env["FOO"]).toBe("bar");
      expect(call[2].env["GIT_ASKPASS"]).toBe("/scripts/askpass.sh");
      expect(call[2].env["GH_TOKEN"]).toBe("scoped-token");
      expect(call[2].env["GITHUB_TOKEN"]).toBeUndefined();
    });

    it("injects hook suppression into prefixed invocations and preserves opts.env", async () => {
      const client = new GitClient({ commandPrefix: ["docker", "exec", "worker"] });
      spawnMock.mockReturnValue(makeMockProc("", "", 0));

      await client.run("/repo", ["push", "origin", "main"], { env: { GIT_ASKPASS: "/scripts/askpass.sh" } });

      const call = spawnMock.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }];
      expect(call[0]).toBe("docker");
      expect(call[1]).toEqual(["exec", "worker", "git", ...DISABLED_HOOKS_ARGS, "push", "origin", "main"]);
      expect(call[2].env["GIT_ASKPASS"]).toBe("/scripts/askpass.sh");
    });
  });

  describe("worktreeList", () => {
    it("parses --porcelain k/v output into entries", async () => {
      const client = new GitClient();
      const porcelainOutput = [
        "worktree /repo",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /workspace/wf_task",
        "HEAD def456",
        "branch refs/heads/minions/wf_task",
        "",
      ].join("\n");

      spawnMock.mockReturnValue(makeMockProc(porcelainOutput, "", 0));

      const result = await client.worktreeList("/repo");

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ path: "/repo", head: "abc123", branch: "refs/heads/main" });
      expect(result[1]).toEqual({
        path: "/workspace/wf_task",
        head: "def456",
        branch: "refs/heads/minions/wf_task",
      });
    });

    it("handles detached HEAD (no branch line)", async () => {
      const client = new GitClient();
      const porcelainOutput = [
        "worktree /workspace/detached",
        "HEAD abc123",
        "detached",
        "",
      ].join("\n");

      spawnMock.mockReturnValue(makeMockProc(porcelainOutput, "", 0));

      const result = await client.worktreeList("/repo");

      expect(result).toHaveLength(1);
      expect(result[0]!.branch).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("kills and rejects a timed-out command", async () => {
      vi.useFakeTimers();
      try {
        const client = new GitClient({ timeoutMs: 50 });
        const proc = makeHangingProc();
        spawnMock.mockReturnValue(proc);

        const promise = client.run("/repo", ["fetch"]);
        const assertion = expect(promise).rejects.toMatchObject({ exitCode: 124 });
        await vi.advanceTimersByTimeAsync(50);

        await assertion;
        expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
      } finally {
        vi.useRealTimers();
      }
    });

    it("spawn non-zero exit surfaces as GitError", async () => {
      const client = new GitClient();
      spawnMock.mockReturnValue(makeMockProc("", "fatal: not a git repository", 128));

      await expect(client.revParse("/not-a-repo", "HEAD")).rejects.toThrow(GitError);
    });

    it("GitError carries stdout, stderr, exitCode", async () => {
      const client = new GitClient();
      spawnMock.mockReturnValue(makeMockProc("out", "err", 1));

      let caught: unknown;
      try {
        await client.worktreePrune("/repo");
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(GitError);
      const err = caught as GitError;
      expect(err.stdout).toBe("out");
      expect(err.stderr).toBe("err");
      expect(err.exitCode).toBe(1);
    });
  });
});
