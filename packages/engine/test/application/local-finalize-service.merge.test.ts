import { describe, expect, it, vi } from "vitest";
import { LocalFinalizeService } from "../../src/application/local-finalize-service.js";
import { applyCommand } from "../../src/application/commands.js";
import { InMemoryWorkflowRepository, type WorkflowRepository } from "../../src/application/repository.js";
import { createWorkflow } from "../../src/domain/workflow.js";
import type { WorkspaceBackend, WorkspaceHandle } from "../../src/plugins/workspace-backend.js";
import type { GitClient } from "../../src/plugins/git/git-client.js";
import { GitError } from "../../src/plugins/git/git-client.js";
import { silentLogger } from "../test-helpers.js";
import { buildRepoRegistry } from "../../src/application/repo-registry.js";

const NOW = "2026-05-10T00:00:00.000Z";
const now = () => NOW;
const WORKFLOW_ID = "wf-merge-test";
const TASK_ID = "wf-merge-test:task";
const WORKSPACE_ID = "ws-wf-merge-test-abc123_task-def456";
const BRANCH = "minions/wf-merge-test_task";
const BASE_BRANCH = "main";
const REPO_PATH = "/fake/repo";
const REPO_REGISTRY = buildRepoRegistry(
  [{ id: "fixture-repo", label: "fixture-repo", localPath: REPO_PATH, defaultBranch: BASE_BRANCH }],
  { reposRoot: "/fake/repos" },
);

function makeHandle(): WorkspaceHandle {
  return {
    workspaceId: WORKSPACE_ID,
    repoId: "fixture-repo",
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

function withLatestCursor(repo: InMemoryWorkflowRepository, latestCursor: number): WorkflowRepository {
  return {
    get: repo.get.bind(repo),
    save: repo.save.bind(repo),
    delete: repo.delete.bind(repo),
    eventsSince: repo.eventsSince.bind(repo),
    latestCursor: async () => latestCursor,
    subscribe: repo.subscribe.bind(repo),
    publishTransient: repo.publishTransient.bind(repo),
    lookupIdempotency: repo.lookupIdempotency.bind(repo),
    listRecoverable: repo.listRecoverable.bind(repo),
    list: repo.list.bind(repo),
    appendTranscript: repo.appendTranscript.bind(repo),
    listTranscript: repo.listTranscript.bind(repo),
  };
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
      repoRegistry: REPO_REGISTRY,
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
      repoRegistry: REPO_REGISTRY,
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
      repoRegistry: REPO_REGISTRY,
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
      repoRegistry: REPO_REGISTRY,
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
      repoRegistry: REPO_REGISTRY,
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
      repoRegistry: REPO_REGISTRY,
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

  it("skips repos rejected by the local finalize predicate", async () => {
    const repo = new InMemoryWorkflowRepository();
    await makeWorkflowInFinalizing(repo);

    const gitClient = makeGitClient();
    const ctrl = new AbortController();
    const svc = new LocalFinalizeService({
      workflowRepo: repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      signal: ctrl.signal,
      now,
      log: silentLogger(),
      shouldFinalize: () => false,
      workspace: makeWorkspace(makeHandle()),
      gitClient,
      repoRegistry: REPO_REGISTRY,
    });

    svc.attach(WORKFLOW_ID);
    await new Promise<void>((r) => setTimeout(r, 30));

    expect(gitClient.revParse).not.toHaveBeenCalled();
    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("finalizing");
    ctrl.abort();
  });

  it("deduplicates overlapping finalization triggers for the same task", async () => {
    const repo = new InMemoryWorkflowRepository();
    await makeWorkflowInFinalizing(repo);

    let resolveMerge: (() => void) | undefined;
    const mergeGate = new Promise<void>((resolve) => {
      resolveMerge = resolve;
    });
    let ffMergeCalls = 0;

    const gitClient: GitClient = {
      revParse: vi.fn().mockImplementation(async (_cwd: string, ref: string) => {
        if (ref === BASE_BRANCH) return "basesha";
        return "somesha";
      }),
      run: vi.fn().mockImplementation(async (_cwd: string, args: string[]) => {
        if (args.includes("rev-list") && args.includes("--count")) {
          return { stdout: "1", stderr: "" };
        }
        if (args.includes("merge") && args.includes("--ff-only")) {
          ffMergeCalls += 1;
          await mergeGate;
          return { stdout: "", stderr: "" };
        }
        if (args.includes("merge") && args.includes("--no-ff")) {
          return { stdout: "", stderr: "" };
        }
        if (args.includes("merge") && args.includes("--abort")) {
          return { stdout: "", stderr: "" };
        }
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

    const ctrl = new AbortController();
    const svc = new LocalFinalizeService({
      workflowRepo: withLatestCursor(repo, 0),
      applyCommand: (cmd) => applyCommand(repo, cmd),
      signal: ctrl.signal,
      now,
      log: silentLogger(),
      workspace: makeWorkspace(makeHandle()),
      gitClient,
      repoRegistry: REPO_REGISTRY,
    });

    svc.attach(WORKFLOW_ID);
    await new Promise<void>((r) => setTimeout(r, 20));

    expect(ffMergeCalls).toBe(1);

    resolveMerge?.();
    await new Promise<void>((r) => setTimeout(r, 20));

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("merged");
    ctrl.abort();
  });
});
