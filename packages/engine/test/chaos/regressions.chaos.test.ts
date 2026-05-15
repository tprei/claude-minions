import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEngine } from "../../src/engine.js";
import { buildRepoRegistry } from "../../src/application/repo-registry.js";
import { runBootRecovery } from "../../src/application/boot.js";
import { CompletionDispatcher } from "../../src/application/completion-dispatcher.js";
import { CIBabysitterService } from "../../src/application/ci-babysitter-service.js";
import { applyCommand } from "../../src/application/commands.js";
import { createRecoveryService } from "../../src/application/recovery-service.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { RunOrchestrator } from "../../src/application/run-orchestrator.js";
import { SchedulerService } from "../../src/application/scheduler-service.js";
import { createWorkflow } from "../../src/domain/workflow.js";
import { GitHubApiError } from "../../src/plugins/github/github-client.js";
import { GitHubScmPlugin } from "../../src/plugins/github/github-scm-plugin.js";
import { GitError } from "../../src/plugins/git/git-client.js";
import { GitWorktreeWorkspaceBackend } from "../../src/plugins/workspace/git-worktree-backend.js";
import { NoopRestackExecutor } from "../../src/application/restack-executor.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { StubProviderPlugin } from "../../src/plugins/providers/stub.js";
import { StubWorkspaceBackend } from "../../src/plugins/workspace/stub-workspace.js";
import { silentLogger } from "../test-helpers.js";
import type { CommandResult } from "../../src/application/commands.js";
import type { WorkflowEvent } from "../../src/domain/events.js";
import type { GhCheckRun, GitHubClient } from "../../src/plugins/github/github-client.js";
import type { GitClient } from "../../src/plugins/git/git-client.js";
import type { MergeService } from "../../src/application/merge-service.js";
import type { Artifact } from "../../src/domain/types.js";
import type { RuntimeBackend, RuntimeOutputChunk } from "../../src/plugins/runtime-backend.js";
import type { RetryTaskService } from "../../src/application/retry-task-service.js";

const describeChaos = process.env["MWF_CHAOS"] === "1" ? describe : describe.skip;

const NOW = "2026-05-13T00:00:00.000Z";
const now = () => NOW;
const WORKFLOW_ID = "wf-chaos";
const TASK_ID = "wf-chaos:task";

function makeGithub(overrides: {
  getPR?: ReturnType<typeof vi.fn>;
  listCheckRuns?: ReturnType<typeof vi.fn>;
}): GitHubClient {
  return {
    getPR: overrides.getPR ?? vi.fn().mockResolvedValue({
      number: 42,
      url: "https://github.com/acme/app/pull/42",
      headSha: "new-head",
      headRef: "feature",
      baseRef: "main",
      mergeable: true,
      mergeableState: "clean",
      state: "open",
      merged: false,
    }),
    listCheckRuns: overrides.listCheckRuns ?? vi.fn().mockResolvedValue([]),
    findPRByHead: vi.fn(),
    createPR: vi.fn(),
    mergePR: vi.fn(),
  } as unknown as GitHubClient;
}

function makeWorkspaceGit(worktreeAdd: ReturnType<typeof vi.fn>): GitClient {
  return {
    run: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    worktreeAdd,
    worktreeRemove: vi.fn().mockResolvedValue(undefined),
    worktreePrune: vi.fn().mockResolvedValue(undefined),
    worktreeList: vi.fn().mockResolvedValue([]),
    revParse: vi.fn().mockResolvedValue("abc123"),
    branchExists: vi.fn().mockResolvedValue(false),
  } as unknown as GitClient;
}

async function makeRunningWorkflow(repo: InMemoryWorkflowRepository, sessionId: string): Promise<void> {
  const wf = createWorkflow({
    id: WORKFLOW_ID,
    kind: "single-task",
    repoId: "fixture-repo",
    tasks: [{ id: TASK_ID, title: "T", prompt: "P" }],
    policy: { maxConcurrent: 1 },
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
      sessionId,
      providerType: "stub",
      runtimeType: "stub",
      workspaceId: "ws-chaos",
      now: NOW,
    },
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition timed out");
}

async function emitSchedulerTick(repo: InMemoryWorkflowRepository): Promise<void> {
  const workflow = await repo.get(WORKFLOW_ID);
  if (!workflow) throw new Error("workflow missing");
  const task = workflow.graph[TASK_ID];
  if (!task) throw new Error("task missing");
  const event: WorkflowEvent = {
    cursor: 0,
    workflowId: WORKFLOW_ID,
    occurredAt: NOW,
    kind: "task-transitioned",
    payload: {
      taskId: TASK_ID,
      fromExecutionStatus: task.executionStatus,
      toExecutionStatus: task.executionStatus,
      fromStackStatus: task.stackStatus,
      toStackStatus: task.stackStatus,
      taskVersion: task.version,
    },
  };
  await repo.save({ ...workflow, version: workflow.version + 1, updatedAt: NOW }, [event]);
}

async function makeFinalizingWorkflow(repo: InMemoryWorkflowRepository): Promise<void> {
  const wf = createWorkflow({
    id: WORKFLOW_ID,
    kind: "single-task",
    repoId: "fixture-repo",
    tasks: [{ id: TASK_ID, title: "T", prompt: "P" }],
    policy: { maxConcurrent: 1, autoLand: true, autoMergeOnGreen: false },
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
    transition: { kind: "mark-running", taskId: TASK_ID, sessionId: "s1", now: NOW },
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

async function openPR(repo: InMemoryWorkflowRepository, extraArtifacts: Artifact[] = []): Promise<void> {
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: {
      kind: "open-review",
      taskId: TASK_ID,
      artifacts: [{ kind: "pr", ref: "https://github.com/acme/app/pull/42", producedBy: "merge-service", createdAt: NOW }, ...extraArtifacts],
      now: NOW,
    },
  });
}

describeChaos("regression chaos probes", () => {
  it("GitHub 429 during PR lookup leaves finalizing task retryable", async () => {
    const repo = new InMemoryWorkflowRepository();
    await makeFinalizingWorkflow(repo);
    const mergeService = {
      openOnly: vi.fn().mockRejectedValue(new GitHubApiError(429, "https://api.github.com/repos/acme/app/pulls", "rate limited", 30)),
      merge: vi.fn(),
    } as unknown as MergeService;
    const ctrl = new AbortController();
    const dispatcher = new CompletionDispatcher({
      workflowRepo: repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      mergeService,
      signal: ctrl.signal,
      now,
      log: silentLogger(),
    });

    dispatcher.attach(WORKFLOW_ID);
    await new Promise((resolve) => setTimeout(resolve, 50));
    ctrl.abort();

    expect((await repo.get(WORKFLOW_ID))?.graph[TASK_ID]?.executionStatus).toBe("finalizing");
  });

  it("stale push rejection fetches and retries before surfacing failure", async () => {
    const retryError = new GitError("git exited with code 1", "", "! [rejected] feature -> feature (fetch first)", 1);
    const run = vi.fn()
      .mockRejectedValueOnce(new GitError("git exited with code 1", "", "! [rejected] feature -> feature (fetch first)", 1))
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(retryError);
    const scm = new GitHubScmPlugin({
      github: makeGithub({}),
      git: { run } as unknown as GitClient,
      token: "tok",
    });

    await expect(scm.pushBranch("/repo", "feature")).rejects.toBe(retryError);
    expect(run.mock.calls.map((call) => call[1][0])).toEqual(["push", "fetch", "push"]);
  });

  it("CI fail then new-head green polls again instead of tripping old report cap", async () => {
    const repo = new InMemoryWorkflowRepository();
    await makeFinalizingWorkflow(repo);
    const oldReport: Artifact = {
      kind: "ci-report",
      ref: JSON.stringify({ prNumber: 42, headSha: "old-head", failed: [{ name: "ci" }] }),
      producedBy: "ci-babysitter",
      createdAt: NOW,
    };
    await openPR(repo, [oldReport]);
    const ctrl = new AbortController();
    const listCheckRuns = vi.fn().mockResolvedValue([
      { name: "ci", status: "completed", conclusion: "success" } satisfies GhCheckRun,
    ]);
    const chaosRegistry = buildRepoRegistry(
      [{ id: "fixture-repo", label: "fixture-repo", remote: "https://github.com/acme/app.git", localPath: "/tmp/fixture-repo" }],
      { reposRoot: "/tmp" },
    );
    const service = new CIBabysitterService({
      workflowRepo: repo,
      github: makeGithub({ listCheckRuns }),
      repoRegistry: chaosRegistry,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      continueTaskService: { run: vi.fn().mockResolvedValue({ workflow: null, events: [] } as unknown as CommandResult) } as never,
      signal: ctrl.signal,
      now,
      sleep: async () => {},
      cadence: { intervals: [{ afterMs: 0, everyMs: 1 }], maxHorizonMs: 1000, noChecksBailMs: 1000, confirmationDelayMs: 1 },
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((resolve) => setTimeout(resolve, 50));
    ctrl.abort();

    expect(listCheckRuns).toHaveBeenCalled();
  });

  it("two engines sharing one SQLite path start and close without corrupting state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mwf-two-engine-"));
    const dbPath = join(dir, "engine.db");
    const chaosTwoEngineRepos = [{ id: "fixture-repo", label: "fixture-repo", localPath: "/tmp/fake-repo" }];
    const engine1 = await createEngine({
      dbPath,
      repos: chaosTwoEngineRepos,
      executor: new NoopRestackExecutor(),
      runtime: new StubRuntimeBackend(),
      recoveryScanIntervalMs: 0,
      log: silentLogger(),
    });
    const engine2 = await createEngine({
      dbPath,
      repos: chaosTwoEngineRepos,
      executor: new NoopRestackExecutor(),
      runtime: new StubRuntimeBackend(),
      recoveryScanIntervalMs: 0,
      log: silentLogger(),
    });

    try {
      const wf = createWorkflow({
        id: WORKFLOW_ID,
        kind: "single-task",
        repoId: "fixture-repo",
        tasks: [{ id: TASK_ID, title: "T", prompt: "P" }],
      }, now);
      await engine1.repo.save(wf, []);
      expect(await engine2.repo.get(WORKFLOW_ID)).toBeDefined();
    } finally {
      await engine2.close();
      await engine1.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("boot replay after a post-final crash completes once without duplicate terminal transitions", async () => {
    const repo = new InMemoryWorkflowRepository();
    await makeRunningWorkflow(repo, "live-session");
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "update-run", taskId: TASK_ID, providerSessionRef: "ref-final", now: NOW },
    });

    const runtime: RuntimeBackend = {
      async start() {
        return { sessionId: "live-session", runtimeType: "stub" };
      },
      async stop() {},
      async probe() {
        return "live";
      },
      attach(_sessionId: string): AsyncIterable<RuntimeOutputChunk> {
        const line = new TextEncoder().encode("final\n");
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { sessionId: "live-session", offset: 0, bytes: line };
          },
        };
      },
    };
    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, now, silentLogger());
    const orchestrators: Promise<void>[] = [];

    const report = await runBootRecovery(repo, service, runtime, {
      now,
      staleReadyMs: 1,
      staleGateMs: 1,
      spawnOrchestrator: (ctx) => {
        const orchestrator = new RunOrchestrator({
          workflowId: ctx.workflowId,
          taskId: ctx.taskId,
          runId: ctx.runId,
          runtimeSessionId: ctx.runtimeSessionId,
          provider: new StubProviderPlugin({ frames: [[{ kind: "final", sessionRef: "ref-final" }]] }),
          runtime,
          workspace: new StubWorkspaceBackend(),
          workspaceId: ctx.workspaceId ?? "",
          applyCommand: (cmd) => applyCommand(repo, cmd),
          publish: () => {},
          now,
          log: silentLogger(),
        });
        orchestrators.push(orchestrator.run());
      },
    });

    await Promise.all(orchestrators);

    expect(report.orchestratorsSpawned).toBe(1);
    expect((await repo.get(WORKFLOW_ID))?.graph[TASK_ID]?.executionStatus).toBe("completed");
    const terminalTransitions = (await repo.eventsSince(WORKFLOW_ID, 0)).filter((event) =>
      event.kind === "task-transitioned" &&
      event.payload.taskId === TASK_ID &&
      event.payload.toExecutionStatus === "completed"
    );
    expect(terminalTransitions).toHaveLength(1);

    const secondReport = await runBootRecovery(repo, service, runtime, {
      now,
      staleReadyMs: 1,
      staleGateMs: 1,
      spawnOrchestrator: () => {
        throw new Error("completed workflow should not respawn");
      },
    });
    expect(secondReport.orchestratorsSpawned).toBe(0);
  });

  it("dead runtime probe recovers the running task and does not respawn an orchestrator", async () => {
    const repo = new InMemoryWorkflowRepository();
    await makeRunningWorkflow(repo, "tmux-dead-session");
    const runtime: RuntimeBackend = {
      async start() {
        return { sessionId: "unused", runtimeType: "stub" };
      },
      async stop() {},
      async probe() {
        return "dead";
      },
      attach(): AsyncIterable<RuntimeOutputChunk> {
        return { [Symbol.asyncIterator]: async function* () {} };
      },
    };
    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, now, silentLogger());

    const report = await runBootRecovery(repo, service, runtime, {
      now,
      staleReadyMs: 1,
      staleGateMs: 1,
      spawnOrchestrator: () => {
        throw new Error("dead runtime should not respawn");
      },
    });

    const task = (await repo.get(WORKFLOW_ID))?.graph[TASK_ID];
    expect(report.workflowsScanned).toBe(1);
    expect(report.orchestratorsSpawned).toBe(0);
    expect(task?.executionStatus).toBe("pending");
    expect(task?.sessionId).toBeUndefined();
    expect(task?.runs[0]?.terminalReason).toBe("recovered");
  });

  it("300 pre-existing worktree directories cannot make create exceed the operation timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mwf-worktree-timeout-"));
    const repoPath = join(dir, "repo");
    const workspaceRoot = join(dir, "worktrees");
    await mkdir(repoPath, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await Promise.all(Array.from({ length: 300 }, (_, i) => mkdir(join(workspaceRoot, `pre-${i}`))));
    const git = makeWorkspaceGit(vi.fn(() => new Promise<void>(() => {})));
    const backend = await GitWorktreeWorkspaceBackend.create({
      gitClient: git,
      repoPath,
      workspaceRoot,
      operationTimeoutMs: 20,
    });

    const startedAt = Date.now();
    await expect(
      backend.create({ workflowId: "wf-timeout", taskId: "task-timeout", repoId: "fixture-repo", branch: "b", mode: "worktree" }),
    ).rejects.toMatchObject({ code: "lock_timeout" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await rm(dir, { recursive: true, force: true });
  });

  it("stuck worktree creation times out and releases the per-repo lock for later creates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mwf-worktree-lock-"));
    const repoPath = join(dir, "repo");
    const workspaceRoot = join(dir, "worktrees");
    await mkdir(repoPath, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    const worktreeAdd = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(() => {}))
      .mockResolvedValueOnce(undefined);
    const git = makeWorkspaceGit(worktreeAdd);
    const backend = await GitWorktreeWorkspaceBackend.create({
      gitClient: git,
      repoPath,
      workspaceRoot,
      operationTimeoutMs: 20,
    });

    await expect(
      backend.create({ workflowId: "wf-stuck", taskId: "task-stuck", repoId: "fixture-repo", branch: "b1", mode: "worktree" }),
    ).rejects.toMatchObject({ code: "lock_timeout" });
    await expect(
      backend.create({ workflowId: "wf-next", taskId: "task-next", repoId: "fixture-repo", branch: "b2", mode: "worktree" }),
    ).resolves.toMatchObject({ workspaceId: expect.stringContaining("ws-") });
    expect(worktreeAdd).toHaveBeenCalledTimes(2);
    await rm(dir, { recursive: true, force: true });
  });

  it("second identical quota failure backs off scheduler dispatch instead of re-spawning", async () => {
    const repo = new InMemoryWorkflowRepository();
    const wf = createWorkflow({
      id: WORKFLOW_ID,
      kind: "single-task",
      repoId: "fixture-repo",
      tasks: [{ id: TASK_ID, title: "T", prompt: "P" }],
      policy: { maxConcurrent: 1 },
    }, now);
    await repo.save(wf, []);
    const retry = {
      run: vi.fn().mockRejectedValue(new Error("quota exhausted")),
    } as unknown as RetryTaskService;
    const ctrl = new AbortController();
    const service = new SchedulerService({
      repo,
      retry,
      signal: ctrl.signal,
      log: silentLogger(),
      nowMs: () => 0,
      dispatchBackoffMs: 60_000,
    });

    service.attach(WORKFLOW_ID);
    await waitUntil(() => vi.mocked(retry.run).mock.calls.length >= 1);
    await emitSchedulerTick(repo);
    await waitUntil(() => vi.mocked(retry.run).mock.calls.length >= 2);
    await emitSchedulerTick(repo);
    await new Promise((resolve) => setTimeout(resolve, 50));
    ctrl.abort();

    expect(vi.mocked(retry.run)).toHaveBeenCalledTimes(2);
  });
});
