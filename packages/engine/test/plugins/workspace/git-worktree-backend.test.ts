import { describe, expect, it, vi, beforeEach } from "vitest";
import { GitWorktreeWorkspaceBackend } from "../../../src/plugins/workspace/git-worktree-backend.js";
import type { GitClient } from "../../../src/plugins/git/git-client.js";

vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(async (p: unknown) => String(p)),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }),
}));

const FAKE_REPO = "/fake/repo";
const FAKE_ROOT = "/fake/workspaces";

function makeGitClient(): GitClient {
  return {
    run: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    worktreeAdd: vi.fn().mockResolvedValue(undefined),
    worktreeRemove: vi.fn().mockResolvedValue(undefined),
    worktreePrune: vi.fn().mockResolvedValue(undefined),
    worktreeList: vi.fn().mockResolvedValue([]),
    revParse: vi.fn().mockResolvedValue("abc123"),
    branchExists: vi.fn().mockResolvedValue(false),
  } as unknown as GitClient;
}

async function makeBackend(gitClient: GitClient): Promise<GitWorktreeWorkspaceBackend> {
  return GitWorktreeWorkspaceBackend.create({
    gitClient,
    repoPath: FAKE_REPO,
    workspaceRoot: FAKE_ROOT,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  const fsp = vi.mocked(await import("node:fs/promises"));
  fsp.realpath.mockImplementation(async (p) => String(p));
  fsp.mkdir.mockResolvedValue(undefined);
  fsp.rm.mockResolvedValue(undefined);
  fsp.access.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
});

describe("GitWorktreeWorkspaceBackend", () => {
  describe("create — worktree mode", () => {
    it("calls gitClient.worktreeAdd with correct path and branch", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);

      const handle = await backend.create({
        workflowId: "wf1",
        taskId: "task1",
        branch: "minions/wf1_task1",
        mode: "worktree",
      });

      expect(gitClient.worktreeAdd).toHaveBeenCalledOnce();
      expect(gitClient.worktreeAdd).toHaveBeenCalledWith(
        FAKE_REPO,
        expect.objectContaining({ path: "/fake/workspaces/wf1-a16d54_task1-943be8", branch: "minions/wf1_task1" }),
      );
      expect(handle.workspaceId).toBe("ws-wf1-a16d54_task1-943be8");
      expect(handle.path).toBe("/fake/workspaces/wf1-a16d54_task1-943be8");
      expect(handle.mode).toBe("worktree");
    });
  });

  describe("create — existing mode", () => {
    it("returns passthrough handle with repoPath, no git ops", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);

      const handle = await backend.create({
        workflowId: "wf1",
        taskId: "task1",
        branch: "main",
        mode: "existing",
      });

      expect(gitClient.worktreeAdd).not.toHaveBeenCalled();
      expect(handle.mode).toBe("existing");
      expect(handle.path).toBe(FAKE_REPO);
      expect(handle.workspaceId).toBe("existing-wf1-a16d54_task1-943be8");
    });
  });

  describe("local mode: path is containerPath", () => {
    it("containerPath equals path in local mode", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);

      const handle = await backend.create({ workflowId: "wf1", taskId: "task1", branch: "b", mode: "worktree" });

      expect(handle.containerPath).toBe(handle.path);
    });
  });

  describe("mutex serialization", () => {
    it("two concurrent creates against the same repo execute sequentially", async () => {
      const order: number[] = [];
      let release!: () => void;
      const barrier = new Promise<void>((r) => { release = r; });

      const gitClient = makeGitClient();
      let callCount = 0;
      (gitClient.worktreeAdd as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        const n = ++callCount;
        if (n === 1) {
          order.push(1);
          await barrier;
        } else {
          order.push(2);
        }
      });

      const backend = await makeBackend(gitClient);

      const p1 = backend.create({ workflowId: "wf-a", taskId: "task-a", branch: "b-a", mode: "worktree" });
      const p2 = backend.create({ workflowId: "wf-b", taskId: "task-b", branch: "b-b", mode: "worktree" });

      // Let p1 start
      await new Promise((r) => setImmediate(r));
      // Release p1
      release();
      await Promise.all([p1, p2]);

      // p1 must start before p2 since they share the same repoPath lock
      expect(order).toEqual([1, 2]);
    });

    it("different repos run in parallel (no cross-repo blocking)", async () => {
      const calls: string[] = [];
      let resolveFirst!: () => void;
      const firstBarrier = new Promise<void>((r) => { resolveFirst = r; });

      const gitClientA = makeGitClient();
      const gitClientB = makeGitClient();

      (gitClientA.worktreeAdd as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        calls.push("A-start");
        await firstBarrier;
        calls.push("A-end");
      });
      (gitClientB.worktreeAdd as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        calls.push("B");
      });

      const backendA = await GitWorktreeWorkspaceBackend.create({
        gitClient: gitClientA,
        repoPath: "/repo-a",
        workspaceRoot: FAKE_ROOT,
      });
      const backendB = await GitWorktreeWorkspaceBackend.create({
        gitClient: gitClientB,
        repoPath: "/repo-b",
        workspaceRoot: FAKE_ROOT,
      });

      const pA = backendA.create({ workflowId: "wf-a", taskId: "t-a", branch: "b-a", mode: "worktree" });
      const pB = backendB.create({ workflowId: "wf-b", taskId: "t-b", branch: "b-b", mode: "worktree" });

      await new Promise((r) => setImmediate(r));
      // B should have started while A is still held
      expect(calls).toContain("A-start");
      expect(calls).toContain("B");
      resolveFirst();
      await Promise.all([pA, pB]);
    });
  });

  describe("path validation", () => {
    it("accepts valid alphanumeric ids", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);

      await expect(
        backend.create({ workflowId: "wf-1", taskId: "task_1", branch: "b", mode: "worktree" }),
      ).resolves.toBeDefined();
    });

    it("special-char-only id (..) maps to hash-only slug and is accepted", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);

      const handle = await backend.create({ workflowId: "..", taskId: "task1", branch: "b", mode: "worktree" });
      // ".." sanitizes to "" but hash "5ec1f7" is used; workspaceId must not contain ".."
      expect(handle.workspaceId).not.toContain("..");
      expect(handle.workspaceId).toContain("5ec1f7");
    });
  });

  describe("cleanup", () => {
    it("cleanup of unknown id is a no-op", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);

      await expect(backend.cleanup("nonexistent-id")).resolves.toBeUndefined();
      expect(gitClient.worktreeRemove).not.toHaveBeenCalled();
    });

    it("cleanup of existing mode just removes from handles, no git ops", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);

      const handle = await backend.create({ workflowId: "wf1", taskId: "task1", branch: "b", mode: "existing" });
      await backend.cleanup(handle.workspaceId);

      expect(gitClient.worktreeRemove).not.toHaveBeenCalled();

      // Second cleanup is idempotent
      await expect(backend.cleanup(handle.workspaceId)).resolves.toBeUndefined();
    });

    it("second cleanup of same worktree id is idempotent (git ops run again, swallowing not-found)", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);

      const handle = await backend.create({ workflowId: "wf1", taskId: "task1", branch: "b", mode: "worktree" });
      await backend.cleanup(handle.workspaceId);
      await expect(backend.cleanup(handle.workspaceId)).resolves.toBeUndefined();
    });

    it("swallows not_found error from worktreeRemove", async () => {
      const gitClient = makeGitClient();
      const { GitError } = await import("../../../src/plugins/git/git-client.js");
      (gitClient.worktreeRemove as ReturnType<typeof vi.fn>).mockRejectedValue(
        new GitError("failed", "", "is not a working tree", 128),
      );

      const backend = await makeBackend(gitClient);
      const handle = await backend.create({ workflowId: "wf1", taskId: "task1", branch: "b", mode: "worktree" });

      await expect(backend.cleanup(handle.workspaceId)).resolves.toBeUndefined();
    });

    it("cleanup by workspaceId not in handles map (post-restart) executes git ops via computed path", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);

      // Simulate a workspaceId from a persisted TaskNode — backend has no in-memory handle for it
      await expect(backend.cleanup("ws-wf1-a16d54_task1-943be8")).resolves.toBeUndefined();
      expect(gitClient.worktreeRemove).toHaveBeenCalledOnce();
      expect(gitClient.worktreeRemove).toHaveBeenCalledWith(
        FAKE_REPO,
        "/fake/workspaces/wf1-a16d54_task1-943be8",
        { force: true },
      );
    });
  });

  describe("resetBranch", () => {
    it("resetBranch: true passes resetBranch to worktreeAdd", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);

      await backend.create({
        workflowId: "wf1",
        taskId: "task1",
        branch: "minions/wf1_task1",
        mode: "worktree",
        resetBranch: true,
      });

      expect(gitClient.worktreeAdd).toHaveBeenCalledWith(
        FAKE_REPO,
        expect.objectContaining({ resetBranch: true }),
      );
    });

    it("resetBranch: false passes resetBranch: false to worktreeAdd", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);

      await backend.create({
        workflowId: "wf1",
        taskId: "task1",
        branch: "minions/wf1_task1",
        mode: "worktree",
        resetBranch: false,
      });

      expect(gitClient.worktreeAdd).toHaveBeenCalledWith(
        FAKE_REPO,
        expect.objectContaining({ resetBranch: false }),
      );
    });
  });

  describe("create — idempotent on existing worktree", () => {
    it("reuses existing worktree when resetBranch is not set (continue-task intent)", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);
      const fsp = vi.mocked(await import("node:fs/promises"));

      const worktreePath = "/fake/workspaces/wf1-a16d54_task1-943be8";
      // Simulate: worktreePath/.git exists → it's a worktree
      fsp.access.mockImplementation(async (p) => {
        if (String(p) === `${worktreePath}/.git`) return undefined;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const handle = await backend.create({
        workflowId: "wf1",
        taskId: "task1",
        branch: "minions/wf1_task1",
        mode: "worktree",
      });

      expect(gitClient.worktreeAdd).not.toHaveBeenCalled();
      expect(handle.path).toBe(worktreePath);
      expect(handle.workspaceId).toBe("ws-wf1-a16d54_task1-943be8");
    });

    it("tears down and recreates when resetBranch: true (retry-task intent)", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);
      const fsp = vi.mocked(await import("node:fs/promises"));

      const worktreePath = "/fake/workspaces/wf1-a16d54_task1-943be8";
      fsp.access.mockImplementation(async (p) => {
        if (String(p) === `${worktreePath}/.git`) return undefined;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      await backend.create({
        workflowId: "wf1",
        taskId: "task1",
        branch: "minions/wf1_task1",
        mode: "worktree",
        resetBranch: true,
      });

      expect(gitClient.worktreeRemove).toHaveBeenCalledOnce();
      expect(gitClient.worktreeRemove).toHaveBeenCalledWith(FAKE_REPO, worktreePath, { force: true });
      expect(gitClient.worktreePrune).toHaveBeenCalledOnce();
      expect(fsp.rm).toHaveBeenCalledWith(worktreePath, { recursive: true, force: true });
      expect(gitClient.worktreeAdd).toHaveBeenCalledOnce();
      expect(gitClient.worktreeAdd).toHaveBeenCalledWith(
        FAKE_REPO,
        expect.objectContaining({ resetBranch: true }),
      );
    });

    it("removes stale directory (no .git file) then creates fresh worktree", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);
      const fsp = vi.mocked(await import("node:fs/promises"));

      const worktreePath = "/fake/workspaces/wf1-a16d54_task1-943be8";
      // .git access fails but directory itself is accessible → stale dir
      fsp.access.mockImplementation(async (p) => {
        if (String(p) === worktreePath) return undefined;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      await backend.create({
        workflowId: "wf1",
        taskId: "task1",
        branch: "minions/wf1_task1",
        mode: "worktree",
      });

      expect(fsp.rm).toHaveBeenCalledWith(worktreePath, { recursive: true, force: true });
      expect(gitClient.worktreeAdd).toHaveBeenCalledOnce();
    });
  });

  describe("get", () => {
    it("after create, get returns matching handle (cache hit)", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);
      const fsp = vi.mocked(await import("node:fs/promises"));

      const created = await backend.create({ workflowId: "wf1", taskId: "task1", branch: "b", mode: "worktree" });

      // Simulate worktree still present so cache-hit re-validation passes
      fsp.access.mockImplementation(async (p) => {
        if (String(p) === `${created.path}/.git`) return undefined;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const got = await backend.get(created.workspaceId);

      expect(got).toBeDefined();
      expect(got!.workspaceId).toBe(created.workspaceId);
      expect(got!.path).toBe(created.path);
      expect(gitClient.run).not.toHaveBeenCalled();
    });

    it("unknown workspaceId returns undefined", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);

      const got = await backend.get("ws-totally-unknown");
      expect(got).toBeUndefined();
    });

    it("existing- workspaceId returns undefined", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);

      const got = await backend.get("existing-wf1-a16d54_task1-943be8");
      expect(got).toBeUndefined();
    });

    it("ws- workspaceId with live worktree (no cache) reads branch from git", async () => {
      const gitClient = makeGitClient();
      (gitClient.run as ReturnType<typeof vi.fn>).mockResolvedValue({ stdout: "minions/wf1_task1\n", stderr: "" });
      const backend = await makeBackend(gitClient);
      const fsp = vi.mocked(await import("node:fs/promises"));

      const worktreePath = "/fake/workspaces/wf1-a16d54_task1-943be8";
      fsp.access.mockImplementation(async (p) => {
        if (String(p) === `${worktreePath}/.git`) return undefined;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const got = await backend.get("ws-wf1-a16d54_task1-943be8");

      expect(got).toBeDefined();
      expect(got!.branch).toBe("minions/wf1_task1");
      expect(got!.path).toBe(worktreePath);
      expect(gitClient.run).toHaveBeenCalledWith(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    });

    it("after cleanup, get returns undefined (cache miss + absent probe)", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);

      const created = await backend.create({ workflowId: "wf1", taskId: "task1", branch: "b", mode: "worktree" });
      await backend.cleanup(created.workspaceId);

      const got = await backend.get(created.workspaceId);
      expect(got).toBeUndefined();
    });

    it("cache hit returns undefined when worktree deleted out-of-band", async () => {
      const gitClient = makeGitClient();
      const backend = await makeBackend(gitClient);
      const fsp = vi.mocked(await import("node:fs/promises"));

      const worktreePath = "/fake/workspaces/wf1-a16d54_task1-943be8";

      // First: .git exists so worktreeAdd and create succeed (probe sees a worktree)
      fsp.access.mockImplementation(async (p) => {
        if (String(p) === `${worktreePath}/.git`) return undefined;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const created = await backend.create({ workflowId: "wf1", taskId: "task1", branch: "b", mode: "worktree" });

      // Simulate out-of-band deletion: .git no longer accessible
      fsp.access.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

      const got = await backend.get(created.workspaceId);
      expect(got).toBeUndefined();
    });

    it("crafted workspaceId with .. path traversal returns undefined from get()", async () => {
      const gitClient = makeGitClient();
      const fsp = vi.mocked(await import("node:fs/promises"));

      fsp.realpath.mockImplementation(async (p) => {
        const s = String(p);
        if (s === FAKE_ROOT) return FAKE_ROOT;
        // dirname of "/fake/workspaces/..victim" is "/fake/workspaces"
        // dirname of "/fake/workspaces/../victim" resolves to "/fake"
        if (s === "/fake/workspaces") return "/fake/workspaces";
        if (s.endsWith("/..") || s.includes("/../")) return "/fake";
        return s;
      });

      const backend = await makeBackend(gitClient);

      // Simulate a crafted id whose slug resolves outside workspaceRoot
      const got = await backend.get("ws-../victim");
      expect(got).toBeUndefined();
      expect(gitClient.run).not.toHaveBeenCalled();
    });
  });

  describe("cleanup — path traversal containment guard", () => {
    it("does not call any fs or git ops for an escape-attempt workspaceId", async () => {
      const gitClient = makeGitClient();
      const fsp = vi.mocked(await import("node:fs/promises"));

      // Make realpath resolve to the parent so validateContainment sees the escape
      fsp.realpath.mockImplementation(async (p) => {
        // For the workspaceRoot itself, return as-is
        if (String(p) === FAKE_ROOT) return FAKE_ROOT;
        // For the dirname of the escape path (/fake/workspaces/..), resolve to /fake
        if (String(p) === FAKE_ROOT) return FAKE_ROOT;
        // dirname("ws-../victim") slug "../victim" → worktreePath = "/fake/workspaces/../victim"
        // dirname of that is "/fake/workspaces/.." → resolve to "/fake"
        return String(p).replace(/\/\.$/, "").replace(/\/[^/]+\/\.\.$/, "").replace(/\/\.\.$/, "") || "/";
      });

      const realpathMock = vi.fn(async (p: unknown) => {
        const s = String(p);
        // Simulate: /fake/workspaces → /fake/workspaces (workspaceRoot)
        // /fake/workspaces/.. → /fake (escapes root)
        if (s === "/fake/workspaces") return "/fake/workspaces";
        if (s === "/fake/workspaces/..") return "/fake";
        return s;
      });
      fsp.realpath.mockImplementation(realpathMock);

      const backend = await makeBackend(gitClient);

      await backend.cleanup("ws-../victim");

      expect(gitClient.worktreeRemove).not.toHaveBeenCalled();
      expect(fsp.rm).not.toHaveBeenCalled();
    });
  });
});

describe("GitWorktreeWorkspaceBackend — docker mode", () => {
  const DOCKER_PREFIX = ["docker", "exec", "-u", "1001", "minions-worker"];
  const CONTAINER_REPO = "/workspace/repo";
  const CONTAINER_ROOT = "/workspace/repo-worktrees";

  function makeDockerGitClient(): GitClient {
    return {
      run: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
      worktreeAdd: vi.fn().mockResolvedValue(undefined),
      worktreeRemove: vi.fn().mockResolvedValue(undefined),
      worktreePrune: vi.fn().mockResolvedValue(undefined),
      worktreeList: vi.fn().mockResolvedValue([]),
      revParse: vi.fn().mockResolvedValue("abc123"),
      branchExists: vi.fn().mockResolvedValue(false),
    } as unknown as GitClient;
  }

  it("constructs without calling realpath or mkdir on container-internal paths", async () => {
    const fsp = vi.mocked(await import("node:fs/promises"));
    const gitClient = makeDockerGitClient();

    await GitWorktreeWorkspaceBackend.create({
      gitClient,
      repoPath: CONTAINER_REPO,
      workspaceRoot: CONTAINER_ROOT,
      gitCommandPrefix: DOCKER_PREFIX,
    });

    expect(fsp.realpath).not.toHaveBeenCalled();
    expect(fsp.mkdir).not.toHaveBeenCalled();
  });

  it("uses DockerFs: does not call fsp.access for probe, does not call fsp.rm for cleanup", async () => {
    const fsp = vi.mocked(await import("node:fs/promises"));
    const gitClient = makeDockerGitClient();

    const backend = await GitWorktreeWorkspaceBackend.create({
      gitClient,
      repoPath: CONTAINER_REPO,
      workspaceRoot: CONTAINER_ROOT,
      gitCommandPrefix: DOCKER_PREFIX,
    });

    vi.clearAllMocks();

    const handle = await backend.create({
      workflowId: "wf1",
      taskId: "task1",
      branch: "minions/wf1",
      mode: "worktree",
    });

    expect(fsp.access).not.toHaveBeenCalled();

    await backend.cleanup(handle.workspaceId);

    expect(fsp.rm).not.toHaveBeenCalled();
  });

  it("path and containerPath are equal (container-internal paths, no translation)", async () => {
    const gitClient = makeDockerGitClient();

    const backend = await GitWorktreeWorkspaceBackend.create({
      gitClient,
      repoPath: CONTAINER_REPO,
      workspaceRoot: CONTAINER_ROOT,
      gitCommandPrefix: DOCKER_PREFIX,
    });

    const handle = await backend.create({
      workflowId: "wf1",
      taskId: "task1",
      branch: "minions/wf1",
      mode: "worktree",
    });

    expect(handle.path).toBe(handle.containerPath);
    expect(handle.path.startsWith(CONTAINER_ROOT)).toBe(true);
  });

  it("git ops (worktreeAdd) are called with container-internal paths", async () => {
    const gitClient = makeDockerGitClient();

    const backend = await GitWorktreeWorkspaceBackend.create({
      gitClient,
      repoPath: CONTAINER_REPO,
      workspaceRoot: CONTAINER_ROOT,
      gitCommandPrefix: DOCKER_PREFIX,
    });

    await backend.create({
      workflowId: "wf1",
      taskId: "task1",
      branch: "minions/wf1",
      mode: "worktree",
    });

    expect(gitClient.worktreeAdd).toHaveBeenCalledWith(
      CONTAINER_REPO,
      expect.objectContaining({ path: expect.stringContaining(CONTAINER_ROOT) }),
    );
  });

  it("docker-mode containment guard rejects paths with .. traversal", async () => {
    const gitClient = makeDockerGitClient();

    const backend = await GitWorktreeWorkspaceBackend.create({
      gitClient,
      repoPath: CONTAINER_REPO,
      workspaceRoot: CONTAINER_ROOT,
      gitCommandPrefix: DOCKER_PREFIX,
    });

    // Attempt to clean up a path that would escape workspaceRoot
    // slug "../victim" → worktreePath = /workspace/repo-worktrees/../victim
    // structural check catches the ".." segment
    await backend.cleanup("ws-../victim");
    expect(gitClient.worktreeRemove).not.toHaveBeenCalled();
  });
});
