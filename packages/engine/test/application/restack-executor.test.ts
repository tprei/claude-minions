import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitClient } from "../../src/plugins/git/git-client.js";
import { GitWorktreeWorkspaceBackend } from "../../src/plugins/workspace/git-worktree-backend.js";
import { GitWorktreeRestackExecutor } from "../../src/application/restack-executor.js";
import type { RestackPlan } from "../../src/application/restack.js";
import type { GraphOperation, TaskNode } from "../../src/domain/types.js";

const execFileAsync = promisify(execFile);

const HAS_GIT = process.env["MWF_HAS_GIT"] === "1";

const TS = "2026-01-01T00:00:00.000Z";

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["-C", dir, "init", "-b", "main"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "test@test.com"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "Test"]);
  await execFileAsync("git", ["-C", dir, "commit", "--allow-empty", "-m", "init"]);
}

async function revParse(dir: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", ref]);
  return stdout.trim();
}

async function commitFile(dir: string, filename: string, content: string, message: string): Promise<string> {
  await writeFile(join(dir, filename), content);
  await execFileAsync("git", ["-C", dir, "add", filename]);
  await execFileAsync("git", ["-C", dir, "commit", "-m", message]);
  return revParse(dir, "HEAD");
}

function makeTask(opts: { id: string; workspaceId: string; dependsOn: string[] }): TaskNode {
  return {
    id: opts.id,
    workflowId: "wf-1",
    title: opts.id,
    prompt: opts.id,
    dependsOn: opts.dependsOn,
    executionStatus: "completed",
    stackStatus: "restack-pending",
    priority: 0,
    claims: [],
    contract: { summary: "", expectedArtifacts: [] },
    artifacts: [],
    workspaceId: opts.workspaceId,
    runs: [],
    readiness: "ready",
    version: 1,
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeOperation(opts: {
  ancestorId: string;
  affectedNodeIds: string[];
  fromBase?: string;
  toBase?: string;
}): GraphOperation {
  const op: GraphOperation = {
    id: "op-1",
    workflowId: "wf-1",
    kind: "restack",
    targetNodeId: opts.ancestorId,
    affectedNodeIds: opts.affectedNodeIds,
    status: "running",
    attempt: 1,
    idempotencyKey: "k1",
    createdAt: TS,
    updatedAt: TS,
  };
  if (opts.fromBase !== undefined) op.fromBase = opts.fromBase;
  if (opts.toBase !== undefined) op.toBase = opts.toBase;
  return op;
}

describe.skipIf(!HAS_GIT)("GitWorktreeRestackExecutor", () => {
  it("rebases child branch onto parent's new head", async () => {
    const base = await mkdtemp(join(tmpdir(), "restack-exec-happy-"));
    const repoPath = join(base, "repo");
    const workspaceRoot = join(base, "workspaces");

    try {
      await execFileAsync("mkdir", ["-p", repoPath, workspaceRoot]);
      await initRepo(repoPath);

      const gitClient = new GitClient();
      const workspace = await GitWorktreeWorkspaceBackend.create({
        gitClient,
        repoPath,
        workspaceRoot,
      });

      const parentHandle = await workspace.create({
        workflowId: "wf-1",
        taskId: "parent",
        branch: "minions/parent",
        mode: "worktree",
      });

      await commitFile(parentHandle.path, "parent.txt", "v1\n", "parent v1");
      const parentOldHead = await revParse(parentHandle.path, "HEAD");

      const childHandle = await workspace.create({
        workflowId: "wf-1",
        taskId: "child",
        branch: "minions/child",
        mode: "worktree",
        baseRef: "minions/parent",
      });

      expect(await revParse(childHandle.path, "HEAD")).toBe(parentOldHead);

      const childCommit = await commitFile(childHandle.path, "child.txt", "child work\n", "child work");

      await commitFile(parentHandle.path, "other.txt", "p2\n", "parent v2");
      const parentNewHead = await revParse(parentHandle.path, "HEAD");
      expect(parentNewHead).not.toBe(parentOldHead);

      const executor = new GitWorktreeRestackExecutor({ gitClient, workspace, now: () => TS });
      const childTask = makeTask({
        id: "child",
        workspaceId: childHandle.workspaceId,
        dependsOn: ["parent"],
      });
      const plan: RestackPlan = { ancestorId: "parent", descendants: [childTask] };
      const operation = makeOperation({
        ancestorId: "parent",
        affectedNodeIds: ["child"],
        fromBase: parentOldHead,
        toBase: parentNewHead,
      });

      const outcome = await executor.execute(plan, operation);

      expect(outcome.kind).toBe("completed");
      if (outcome.kind !== "completed") return;

      const childFinalHead = await revParse(childHandle.path, "HEAD");
      expect(childFinalHead).not.toBe(childCommit);

      // Parent's new head must be in child branch's ancestry.
      await expect(
        execFileAsync("git", ["-C", childHandle.path, "merge-base", "--is-ancestor", parentNewHead, "minions/child"]),
      ).resolves.toBeDefined();

      // Child work content survives the rebase.
      const { stdout: showChild } = await execFileAsync("git", [
        "-C",
        childHandle.path,
        "show",
        `${childFinalHead}:child.txt`,
      ]);
      expect(showChild).toBe("child work\n");

      // Recorded artifact points at the rebased tip.
      expect(outcome.artifactsByTaskId["child"]).toEqual([
        {
          kind: "commit",
          ref: childFinalHead,
          producedBy: "restack-executor",
          createdAt: TS,
        },
      ]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("returns conflict and aborts rebase when parent and child touch the same line", async () => {
    const base = await mkdtemp(join(tmpdir(), "restack-exec-conflict-"));
    const repoPath = join(base, "repo");
    const workspaceRoot = join(base, "workspaces");

    try {
      await execFileAsync("mkdir", ["-p", repoPath, workspaceRoot]);
      await initRepo(repoPath);

      const gitClient = new GitClient();
      const workspace = await GitWorktreeWorkspaceBackend.create({
        gitClient,
        repoPath,
        workspaceRoot,
      });

      const parentHandle = await workspace.create({
        workflowId: "wf-1",
        taskId: "parent",
        branch: "minions/parent",
        mode: "worktree",
      });

      await commitFile(parentHandle.path, "shared.txt", "alpha\n", "parent baseline");
      const parentOldHead = await revParse(parentHandle.path, "HEAD");

      const childHandle = await workspace.create({
        workflowId: "wf-1",
        taskId: "child",
        branch: "minions/child",
        mode: "worktree",
        baseRef: "minions/parent",
      });

      // Child rewrites shared.txt on its branch.
      await commitFile(childHandle.path, "shared.txt", "child-version\n", "child rewrites shared");
      const childCommit = await revParse(childHandle.path, "HEAD");

      // Parent also rewrites shared.txt — different content, same line: conflict on rebase.
      await commitFile(parentHandle.path, "shared.txt", "parent-version\n", "parent rewrites shared");
      const parentNewHead = await revParse(parentHandle.path, "HEAD");

      const executor = new GitWorktreeRestackExecutor({ gitClient, workspace, now: () => TS });
      const childTask = makeTask({
        id: "child",
        workspaceId: childHandle.workspaceId,
        dependsOn: ["parent"],
      });
      const plan: RestackPlan = { ancestorId: "parent", descendants: [childTask] };
      const operation = makeOperation({
        ancestorId: "parent",
        affectedNodeIds: ["child"],
        fromBase: parentOldHead,
        toBase: parentNewHead,
      });

      const outcome = await executor.execute(plan, operation);

      expect(outcome.kind).toBe("conflict");
      if (outcome.kind !== "conflict") return;
      expect(outcome.error.length).toBeGreaterThan(0);

      // Rebase must have been aborted — HEAD still at the original child commit, no .git/rebase state.
      expect(await revParse(childHandle.path, "HEAD")).toBe(childCommit);
      await expect(
        execFileAsync("git", ["-C", childHandle.path, "status", "--porcelain=v2", "--branch"]),
      ).resolves.toMatchObject({ stdout: expect.not.stringContaining("rebase") });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("returns success without invoking rebase when parent did not move", async () => {
    const base = await mkdtemp(join(tmpdir(), "restack-exec-noop-"));
    const repoPath = join(base, "repo");
    const workspaceRoot = join(base, "workspaces");

    try {
      await execFileAsync("mkdir", ["-p", repoPath, workspaceRoot]);
      await initRepo(repoPath);

      const gitClient = new GitClient();
      const workspace = await GitWorktreeWorkspaceBackend.create({
        gitClient,
        repoPath,
        workspaceRoot,
      });

      const parentHandle = await workspace.create({
        workflowId: "wf-1",
        taskId: "parent",
        branch: "minions/parent",
        mode: "worktree",
      });
      const parentHead = await revParse(parentHandle.path, "HEAD");

      const childHandle = await workspace.create({
        workflowId: "wf-1",
        taskId: "child",
        branch: "minions/child",
        mode: "worktree",
        baseRef: "minions/parent",
      });
      await commitFile(childHandle.path, "child.txt", "c\n", "child work");
      const childHead = await revParse(childHandle.path, "HEAD");

      // Track all git calls — assert no `rebase` subcommand fires when fromBase === toBase.
      const runSpy = vi.spyOn(gitClient, "run");

      const executor = new GitWorktreeRestackExecutor({ gitClient, workspace, now: () => TS });
      const childTask = makeTask({
        id: "child",
        workspaceId: childHandle.workspaceId,
        dependsOn: ["parent"],
      });
      const plan: RestackPlan = { ancestorId: "parent", descendants: [childTask] };
      const operation = makeOperation({
        ancestorId: "parent",
        affectedNodeIds: ["child"],
        fromBase: parentHead,
        toBase: parentHead,
      });

      const outcome = await executor.execute(plan, operation);

      expect(outcome.kind).toBe("completed");
      if (outcome.kind !== "completed") return;
      expect(outcome.artifactsByTaskId).toEqual({});

      const rebaseInvocations = runSpy.mock.calls.filter((call) => {
        const args = call[1] as readonly string[];
        return args[0] === "rebase";
      });
      expect(rebaseInvocations).toHaveLength(0);

      // Child branch was not touched.
      expect(await revParse(childHandle.path, "HEAD")).toBe(childHead);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
