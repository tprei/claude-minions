import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitClient } from "../../src/plugins/git/git-client.js";
import { GitWorktreeWorkspaceBackend } from "../../src/plugins/workspace/git-worktree-backend.js";
import { createWorkflow } from "../../src/domain/workflow.js";
import { deriveBranch, stackBaseRef } from "../../src/application/stacking.js";

const execFileAsync = promisify(execFile);
const HAS_GIT = process.env["MWF_HAS_GIT"] === "1";

const FILE = "reader.txt";

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args]);
  return stdout.trim();
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, "init");
  await git(dir, "config", "user.email", "test@test.com");
  await git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, FILE), "reader=OLD\n");
  await git(dir, "add", FILE);
  await git(dir, "commit", "-m", "base");
  await git(dir, "branch", "-M", "main");
}

// The wf-mpfo6h9k failure in miniature: a parent and a dependent task that both
// rewrite the same line of the same file. With dispatch-time stacking the
// dependent builds on the parent and the stack rebases clean onto the merged
// parent; without it the dependent rewrites from base and collides.
describe.skipIf(!HAS_GIT)("dispatch stacking (real git)", () => {
  const wf = createWorkflow(
    {
      id: "wf-stack-it",
      kind: "manual-dag",
      repoId: "fixture-repo",
      tasks: [
        { id: "A", title: "A", prompt: "a" },
        { id: "B", title: "B", prompt: "b", dependsOn: ["A"] },
      ],
      policy: { maxConcurrent: 2 },
    },
    () => "2026-05-22T00:00:00.000Z",
  );

  it("dependent task's worktree contains its parent's changes and the stack lands clean", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "mwf-stack-"));
    const repoPath = join(baseDir, "repo");
    const workspaceRoot = join(baseDir, "workspaces");
    try {
      await execFileAsync("mkdir", ["-p", repoPath, workspaceRoot]);
      await initRepo(repoPath);

      const gitClient = new GitClient();
      const backend = await GitWorktreeWorkspaceBackend.create({ gitClient, repoPath, workspaceRoot });

      // Parent A: no deps -> base on HEAD. Rewrites the shared line.
      expect(stackBaseRef(wf, "A")).toBeUndefined();
      const aBranch = deriveBranch(wf.id, "A");
      const aWs = await backend.create({
        workflowId: wf.id, taskId: "A", repoId: "fixture-repo",
        branch: aBranch, mode: "worktree", resetBranch: true,
      });
      await writeFile(join(aWs.path, FILE), "reader=A\n");
      await git(aWs.path, "commit", "-am", "A: reader");

      // Dependent B: stacks on A. Its worktree must already contain A's change.
      const bBase = stackBaseRef(wf, "B");
      expect(bBase).toBe(aBranch);
      const bWs = await backend.create({
        workflowId: wf.id, taskId: "B", repoId: "fixture-repo",
        branch: deriveBranch(wf.id, "B"), mode: "worktree", resetBranch: true,
        ...(bBase !== undefined ? { baseRef: bBase } : {}),
      });
      expect(await readFile(join(bWs.path, FILE), "utf8")).toBe("reader=A\n");
      await writeFile(join(bWs.path, FILE), "reader=A+B\n");
      await git(bWs.path, "commit", "-am", "B: reader builds on A");

      // Land: merge A into main, then rebase B onto it — clean, since B already has A.
      await git(repoPath, "merge", "--ff-only", aBranch);
      await git(bWs.path, "rebase", "main");
      expect(await readFile(join(bWs.path, FILE), "utf8")).toBe("reader=A+B\n");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("without stacking the dependent rewrites from base and collides on land (old behavior)", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "mwf-nostack-"));
    const repoPath = join(baseDir, "repo");
    const workspaceRoot = join(baseDir, "workspaces");
    try {
      await execFileAsync("mkdir", ["-p", repoPath, workspaceRoot]);
      await initRepo(repoPath);

      const gitClient = new GitClient();
      const backend = await GitWorktreeWorkspaceBackend.create({ gitClient, repoPath, workspaceRoot });

      const aBranch = deriveBranch(wf.id, "A");
      const aWs = await backend.create({
        workflowId: wf.id, taskId: "A", repoId: "fixture-repo",
        branch: aBranch, mode: "worktree", resetBranch: true,
      });
      await writeFile(join(aWs.path, FILE), "reader=A\n");
      await git(aWs.path, "commit", "-am", "A: reader");

      // Old behavior: B branches from HEAD (no baseRef), never sees A.
      const bWs = await backend.create({
        workflowId: wf.id, taskId: "B", repoId: "fixture-repo",
        branch: deriveBranch(wf.id, "B"), mode: "worktree", resetBranch: true,
      });
      expect(await readFile(join(bWs.path, FILE), "utf8")).toBe("reader=OLD\n");
      await writeFile(join(bWs.path, FILE), "reader=B\n");
      await git(bWs.path, "commit", "-am", "B: reader from base");

      await git(repoPath, "merge", "--ff-only", aBranch);
      await expect(git(bWs.path, "rebase", "main")).rejects.toThrow();
      // git leaves the rebase mid-conflict
      await execFileAsync("git", ["-C", bWs.path, "rebase", "--abort"]);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
