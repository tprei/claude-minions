import { describe, expect, it } from "vitest";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitClient } from "../../../src/plugins/git/git-client.js";
import { GitWorktreeWorkspaceBackend } from "../../../src/plugins/workspace/git-worktree-backend.js";

const execFileAsync = promisify(execFile);

const HAS_GIT = process.env["MWF_HAS_GIT"] === "1";

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["-C", dir, "init"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "test@test.com"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "Test"]);
  // create an initial commit so HEAD exists
  await execFileAsync("git", ["-C", dir, "commit", "--allow-empty", "-m", "init"]);
}

describe.skipIf(!HAS_GIT)("GitWorktreeWorkspaceBackend integration", () => {
  it("create + cleanup: worktree dir and branch ref appear then disappear", async () => {
    const base = await mkdtemp(join(tmpdir(), "mwf-it-"));
    const repoPath = join(base, "repo");
    const workspaceRoot = join(base, "workspaces");

    try {
      await execFileAsync("mkdir", ["-p", repoPath, workspaceRoot]);
      await initGitRepo(repoPath);

      const gitClient = new GitClient();
      const backend = await GitWorktreeWorkspaceBackend.create({
        gitClient,
        repoPath,
        workspaceRoot,
      });

      const handle = await backend.create({
        workflowId: "wf-1",
        taskId: "task-1",
        branch: "minions/wf1_task1",
        mode: "worktree",
      });

      // worktree directory must exist
      await expect(access(handle.path)).resolves.toBeUndefined();

      // branch ref must exist
      const branchExists = await gitClient.branchExists(repoPath, "minions/wf1_task1");
      expect(branchExists).toBe(true);

      await backend.cleanup(handle.workspaceId);

      // worktree directory gone
      await expect(access(handle.path)).rejects.toThrow();

      // list shows only primary worktree
      const entries = await gitClient.worktreeList(repoPath);
      const secondary = entries.filter((e) => e.path !== repoPath);
      expect(secondary).toHaveLength(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("continue-task (resetBranch: false) preserves prior commits on existing branch", async () => {
    const base = await mkdtemp(join(tmpdir(), "mwf-it-"));
    const repoPath = join(base, "repo");
    const workspaceRoot = join(base, "workspaces");

    try {
      await execFileAsync("mkdir", ["-p", repoPath, workspaceRoot]);
      await initGitRepo(repoPath);

      const gitClient = new GitClient();
      const backend = await GitWorktreeWorkspaceBackend.create({
        gitClient,
        repoPath,
        workspaceRoot,
      });

      // First create: simulates initial run (branch created fresh)
      const h1 = await backend.create({
        workflowId: "wf-1",
        taskId: "task-1",
        branch: "minions/wf1_task1",
        mode: "worktree",
        resetBranch: false,
      });

      // Commit something on that branch inside the worktree
      await execFileAsync("git", ["-C", h1.path, "commit", "--allow-empty", "-m", "agent work"]);
      const { stdout } = await execFileAsync("git", ["-C", h1.path, "rev-parse", "HEAD"]);
      const agentCommit = stdout.trim();

      await backend.cleanup(h1.workspaceId);

      // Second create: continue-task — resetBranch: false must check out the existing branch
      const h2 = await backend.create({
        workflowId: "wf-1",
        taskId: "task-1",
        branch: "minions/wf1_task1",
        mode: "worktree",
        resetBranch: false,
      });

      // The agent commit must still be HEAD in the new worktree
      const { stdout: head2 } = await execFileAsync("git", ["-C", h2.path, "rev-parse", "HEAD"]);
      expect(head2.trim()).toBe(agentCommit);

      await backend.cleanup(h2.workspaceId);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("retry-task (resetBranch: true) resets existing branch to HEAD, discarding prior commits", async () => {
    const base = await mkdtemp(join(tmpdir(), "mwf-it-"));
    const repoPath = join(base, "repo");
    const workspaceRoot = join(base, "workspaces");

    try {
      await execFileAsync("mkdir", ["-p", repoPath, workspaceRoot]);
      await initGitRepo(repoPath);

      const gitClient = new GitClient();
      const backend = await GitWorktreeWorkspaceBackend.create({
        gitClient,
        repoPath,
        workspaceRoot,
      });

      const { stdout: headBefore } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "HEAD"]);
      const mainHead = headBefore.trim();

      const h1 = await backend.create({
        workflowId: "wf-1",
        taskId: "task-1",
        branch: "minions/wf1_task1",
        mode: "worktree",
        resetBranch: false,
      });

      await execFileAsync("git", ["-C", h1.path, "commit", "--allow-empty", "-m", "old agent work"]);
      await backend.cleanup(h1.workspaceId);

      // Retry: resetBranch: true resets the branch back to HEAD
      const h2 = await backend.create({
        workflowId: "wf-1",
        taskId: "task-1",
        branch: "minions/wf1_task1",
        mode: "worktree",
        resetBranch: true,
      });

      const { stdout: head2 } = await execFileAsync("git", ["-C", h2.path, "rev-parse", "HEAD"]);
      expect(head2.trim()).toBe(mainHead);

      await backend.cleanup(h2.workspaceId);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("two concurrent creates produce distinct paths and branches", async () => {
    const base = await mkdtemp(join(tmpdir(), "mwf-it-"));
    const repoPath = join(base, "repo");
    const workspaceRoot = join(base, "workspaces");

    try {
      await execFileAsync("mkdir", ["-p", repoPath, workspaceRoot]);
      await initGitRepo(repoPath);

      const gitClient = new GitClient();
      const backend = await GitWorktreeWorkspaceBackend.create({
        gitClient,
        repoPath,
        workspaceRoot,
      });

      const [h1, h2] = await Promise.all([
        backend.create({ workflowId: "wf-1", taskId: "task-1", branch: "minions/wf1_task1", mode: "worktree" }),
        backend.create({ workflowId: "wf-2", taskId: "task-2", branch: "minions/wf2_task2", mode: "worktree" }),
      ]);

      expect(h1.path).not.toBe(h2.path);
      expect(h1.branch).not.toBe(h2.branch);
      await expect(access(h1.path)).resolves.toBeUndefined();
      await expect(access(h2.path)).resolves.toBeUndefined();

      await backend.cleanup(h1.workspaceId);
      await backend.cleanup(h2.workspaceId);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
