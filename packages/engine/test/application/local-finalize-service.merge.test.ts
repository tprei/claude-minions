import { describe, expect, it, vi } from "vitest";
import { LocalFinalizeService } from "../../src/application/local-finalize-service.js";
import { applyCommand } from "../../src/application/commands.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createWorkflow } from "../../src/domain/workflow.js";
import type { WorkspaceBackend, WorkspaceHandle } from "../../src/plugins/workspace-backend.js";
import type { GitClient } from "../../src/plugins/git/git-client.js";
import { GitError } from "../../src/plugins/git/git-client.js";
import { silentLogger } from "../test-helpers.js";

const NOW = "2026-05-10T00:00:00.000Z";
const now = () => NOW;
const WORKFLOW_ID = "wf-merge-test";
const TASK_ID = "wf-merge-test:task";
const WORKSPACE_ID = "ws-wf-merge-test-abc123_task-def456";
const BRANCH = "minions/wf-merge-test_task";
const BASE_BRANCH = "main";
const REPO_PATH = "/fake/repo";

function makeHandle(): WorkspaceHandle {
  return {
    workspaceId: WORKSPACE_ID,
    mode: "worktree",
    path: "/fake/workspaces/wf_task",
    containerPath: "/fake/workspaces/wf_task",
    branch: BRANCH,
  };
}

function makeWorkspace(handle: WorkspaceHandle | undefined): WorkspaceBackend {
  return {
    create: vi.fn(),
    get: vi.fn().mockResolvedValue(handle),
    cleanup: vi.fn(),
  } as unknown as WorkspaceBackend;
}

function makeGitClient(overrides: Partial<{
  revParseResult: string;
  revListResult: string;
  runResults: Record<string, { stdout: string; stderr: string }>;
  mergeError: GitError | null;
  ffMergeError: GitError | null;
}>  = {}): GitClient {
  const defaultRevList = overrides.revListResult ?? "1";

  return {
    revParse: vi.fn().mockImplementation(async (_cwd: string, ref: string) => {
      if (overrides.revParseResult !== undefined) return overrides.revParseResult;
      if (ref === BASE_BRANCH) return "basesha";
      return "somesha";
    }),
    run: vi.fn().mockImplementation(async (_cwd: string, args: string[]) => {
      // rev-list --count base..branch
      if (args.includes("rev-list") && args.includes("--count")) {
        return { stdout: defaultRevList, stderr: "" };
      }
      // merge --ff-only
      if (args.includes("merge") && args.includes("--ff-only")) {
        if (overrides.ffMergeError !== undefined && overrides.ffMergeError !== null) {
          throw overrides.ffMergeError;
        }
        return { stdout: "", stderr: "" };
      }
      // merge --no-ff
      if (args.includes("merge") && args.includes("--no-ff")) {
        if (overrides.mergeError !== undefined && overrides.mergeError !== null) {
          throw overrides.mergeError;
        }
        return { stdout: "", stderr: "" };
      }
      // merge --abort
      if (args.includes("merge") && args.includes("--abort")) {
        return { stdout: "", stderr: "" };
      }
      // reset --hard
      if (args.includes("reset") && args.includes("--hard")) {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }),
    worktreeAdd: vi.fn(),
    worktreeRemove: vi.fn(),
    worktreePrune: vi.fn(),
    worktreeList: vi.fn(),
    branchExists: vi.fn(),
  } as unknown as GitClient;
}

async function makeWorkflowInFinalizing(
  repo: InMemoryWorkflowRepository,
  withWorkspaceId = true,
): Promise<void> {
  const wf = createWorkflow({
    id: WORKFLOW_ID,
    kind: "single-task",
    repoId: "fixture-repo",
    tasks: [{ id: TASK_ID, title: "T", prompt: "P" }],
  }, now);
  await repo.save(wf, []);
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "mark-ready", taskId: TASK_ID, now: NOW },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: {
      kind: "mark-running",
      taskId: TASK_ID,
      sessionId: "s1",
      now: NOW,
      ...(withWorkspaceId ? { workspaceId: WORKSPACE_ID } : {}),
    },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "complete-runtime", taskId: TASK_ID, now: NOW },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "start-finalization", taskId: TASK_ID, now: NOW },
  });
}

describe("LocalFinalizeService — real merge path", () => {
  it("happy path: worktree has commits ahead → ff-only merge succeeds → transitions to merged", async () => {
    const repo = new InMemoryWorkflowRepository();
    await makeWorkflowInFinalizing(repo);

    const gitClient = makeGitClient(); // revListResult defaults to "1", ff-only succeeds
    const workspace = makeWorkspace(makeHandle());

    const ctrl = new AbortController();
    const svc = new LocalFinalizeService({
      workflowRepo: repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      signal: ctrl.signal,
      now,
      log: silentLogger(),
      workspace,
      gitClient,
      repoPath: REPO_PATH,
      baseBranch: BASE_BRANCH,
    });

    svc.attach(WORKFLOW_ID);
    await new Promise<void>((r) => setTimeout(r, 30));

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("merged");
    ctrl.abort();
  });

  it("ff-only fails, no-ff succeeds → transitions to merged", async () => {
    const repo = new InMemoryWorkflowRepository();
    await makeWorkflowInFinalizing(repo);

    const ffError = new GitError("ff-only failed", "", "Not possible to fast-forward", 1);
    const gitClient = makeGitClient({ ffMergeError: ffError });
    const workspace = makeWorkspace(makeHandle());

    const ctrl = new AbortController();
    const svc = new LocalFinalizeService({
      workflowRepo: repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      signal: ctrl.signal,
      now,
      log: silentLogger(),
      workspace,
      gitClient,
      repoPath: REPO_PATH,
      baseBranch: BASE_BRANCH,
    });

    svc.attach(WORKFLOW_ID);
    await new Promise<void>((r) => setTimeout(r, 30));

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("merged");
    ctrl.abort();
  });

  it("no commits on branch → transitions to needs-review", async () => {
    const repo = new InMemoryWorkflowRepository();
    await makeWorkflowInFinalizing(repo);

    const gitClient = makeGitClient({ revListResult: "0" }); // 0 commits ahead
    const workspace = makeWorkspace(makeHandle());

    const ctrl = new AbortController();
    const svc = new LocalFinalizeService({
      workflowRepo: repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      signal: ctrl.signal,
      now,
      log: silentLogger(),
      workspace,
      gitClient,
      repoPath: REPO_PATH,
      baseBranch: BASE_BRANCH,
    });

    svc.attach(WORKFLOW_ID);
    await new Promise<void>((r) => setTimeout(r, 30));

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("needs-review");
    const artifacts = wf?.graph[TASK_ID]?.artifacts ?? [];
    expect(artifacts.some((a) => a.ref.includes("no commits ahead"))).toBe(true);
    ctrl.abort();
  });

  it("merge conflict on both strategies → transitions to needs-review", async () => {
    const repo = new InMemoryWorkflowRepository();
    await makeWorkflowInFinalizing(repo);

    const ffError = new GitError("ff-only failed", "", "Not possible to fast-forward", 1);
    const conflictError = new GitError("merge conflict", "", "CONFLICT (content)", 1);
    const gitClient = makeGitClient({ ffMergeError: ffError, mergeError: conflictError });
    const workspace = makeWorkspace(makeHandle());

    const ctrl = new AbortController();
    const svc = new LocalFinalizeService({
      workflowRepo: repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      signal: ctrl.signal,
      now,
      log: silentLogger(),
      workspace,
      gitClient,
      repoPath: REPO_PATH,
      baseBranch: BASE_BRANCH,
    });

    svc.attach(WORKFLOW_ID);
    await new Promise<void>((r) => setTimeout(r, 30));

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("needs-review");
    const artifacts = wf?.graph[TASK_ID]?.artifacts ?? [];
    expect(artifacts.some((a) => a.ref.includes("merge conflict"))).toBe(true);
    ctrl.abort();
  });

  it("task has no workspaceId → transitions to needs-review", async () => {
    const repo = new InMemoryWorkflowRepository();
    await makeWorkflowInFinalizing(repo, false); // no workspaceId

    const gitClient = makeGitClient();
    const workspace = makeWorkspace(makeHandle());

    const ctrl = new AbortController();
    const svc = new LocalFinalizeService({
      workflowRepo: repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      signal: ctrl.signal,
      now,
      log: silentLogger(),
      workspace,
      gitClient,
      repoPath: REPO_PATH,
      baseBranch: BASE_BRANCH,
    });

    svc.attach(WORKFLOW_ID);
    await new Promise<void>((r) => setTimeout(r, 30));

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("needs-review");
    ctrl.abort();
  });

  it("workspace.get returns undefined → transitions to needs-review", async () => {
    const repo = new InMemoryWorkflowRepository();
    await makeWorkflowInFinalizing(repo);

    const gitClient = makeGitClient();
    const workspace = makeWorkspace(undefined); // workspace returns no handle

    const ctrl = new AbortController();
    const svc = new LocalFinalizeService({
      workflowRepo: repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      signal: ctrl.signal,
      now,
      log: silentLogger(),
      workspace,
      gitClient,
      repoPath: REPO_PATH,
      baseBranch: BASE_BRANCH,
    });

    svc.attach(WORKFLOW_ID);
    await new Promise<void>((r) => setTimeout(r, 30));

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("needs-review");
    ctrl.abort();
  });

  it("no workspace/gitClient/repoPath (stub mode) → transitions to merged without git", async () => {
    const repo = new InMemoryWorkflowRepository();
    await makeWorkflowInFinalizing(repo);

    const ctrl = new AbortController();
    const svc = new LocalFinalizeService({
      workflowRepo: repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      signal: ctrl.signal,
      now,
      log: silentLogger(),
      // intentionally no workspace/gitClient/repoPath
    });

    svc.attach(WORKFLOW_ID);
    await new Promise<void>((r) => setTimeout(r, 30));

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("merged");
    ctrl.abort();
  });
});
