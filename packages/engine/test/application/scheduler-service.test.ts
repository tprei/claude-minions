import { describe, expect, it, vi } from "vitest";
import { SchedulerService } from "../../src/application/scheduler-service.js";
import { RetryTaskService } from "../../src/application/retry-task-service.js";
import { ContinueTaskService } from "../../src/application/continue-task-service.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createSingleTaskWorkflow, createWorkflow } from "../../src/domain/workflow.js";
import { StubProviderPlugin } from "../../src/plugins/providers/stub.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { StubWorkspaceBackend } from "../../src/plugins/workspace/stub-workspace.js";
import { silentLogger } from "../test-helpers.js";
import type { RuntimeAttachOptions, RuntimeBackend, RuntimeOutputChunk, RuntimeStartResult, RuntimeStartSpec } from "../../src/plugins/runtime-backend.js";
import type { RuntimeProbeState } from "../../src/application/recovery.js";
import type { ProviderEvent } from "../../src/plugins/provider-plugin.js";
import { RunOrchestrator } from "../../src/application/run-orchestrator.js";
import { applyCommand } from "../../src/application/commands.js";
import type { NodeRun } from "../../src/domain/runs.js";

const NOW = "2026-05-10T00:00:00.000Z";
const now = () => NOW;

function makeFinalChunk(frameIndex: number): RuntimeOutputChunk {
  // Each "line" triggers a parseFrame call. The line content doesn't matter — stub uses a counter.
  const text = `frame-${frameIndex}\n`;
  const bytes = new TextEncoder().encode(text);
  return { sessionId: "stub-session", offset: 0, bytes };
}

function makeRuntime(frameCount: number): RuntimeBackend {
  let callCount = 0;
  return {
    async start(_spec: RuntimeStartSpec): Promise<RuntimeStartResult> {
      return { sessionId: `stub-${++callCount}`, runtimeType: "stub" };
    },
    async stop(): Promise<void> {},
    async probe(): Promise<RuntimeProbeState> { return "live"; },
    attach(_sessionId: string, _opts?: RuntimeAttachOptions): AsyncIterable<RuntimeOutputChunk> {
      return {
        [Symbol.asyncIterator]: async function* () {
          for (let i = 0; i < frameCount; i++) {
            yield makeFinalChunk(i);
          }
        },
      };
    },
  };
}

async function waitForStatus(
  repo: InMemoryWorkflowRepository,
  workflowId: string,
  taskId: string,
  targetStatus: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const wf = await repo.get(workflowId);
    if (wf?.graph[taskId]?.executionStatus === targetStatus) return;
    await new Promise<void>((r) => setTimeout(r, 10));
  }
  const wf = await repo.get(workflowId);
  const actual = wf?.graph[taskId]?.executionStatus ?? "not-found";
  throw new Error(`Timed out waiting for ${taskId} to reach ${targetStatus}, currently: ${actual}`);
}

class PausedLatestCursorRepository extends InMemoryWorkflowRepository {
  private releaseLatestCursor!: () => void;
  private readonly latestCursorGate = new Promise<void>((resolve) => { this.releaseLatestCursor = resolve; });
  private latestCursorStartedResolve!: () => void;
  readonly latestCursorStarted = new Promise<void>((resolve) => { this.latestCursorStartedResolve = resolve; });

  override async latestCursor(workflowId: string): Promise<number> {
    this.latestCursorStartedResolve();
    await this.latestCursorGate;
    return super.latestCursor(workflowId);
  }

  continueLatestCursor(): void {
    this.releaseLatestCursor();
  }
}

function makeServices(
  repo: InMemoryWorkflowRepository,
  provider: StubProviderPlugin,
  runtime: RuntimeBackend,
  signal: AbortSignal,
): { schedulerService: SchedulerService; retryService: RetryTaskService } {
  const retryService = new RetryTaskService({
    repo,
    applyCommand: (cmd) => applyCommand(repo, cmd),
    providerFactory: () => provider,
    runtime,
    workspace: new StubWorkspaceBackend(),
    now,
    spawnOrchestrator: (deps) => {
      const orch = new RunOrchestrator({
        ...deps,
        signal,
        log: silentLogger(),
        persistTranscript: async () => {},
      });
      void orch.run().catch(() => {});
    },
  });

  const schedulerService = new SchedulerService({
    repo,
    retry: retryService,
    log: silentLogger(),
    signal,
  });

  return { schedulerService, retryService };
}

async function flushMicrotasks(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

describe("SchedulerService", () => {
  it("does not resurrect a subscription when detach wins attach setup", async () => {
    const repo = new PausedLatestCursorRepository();
    const controller = new AbortController();
    const wf = createWorkflow({
      id: "wf-detach-race",
      kind: "single-task",
      repoId: "fixture-repo",
      tasks: [{ id: "t1", title: "T", prompt: "P" }],
    }, now);
    await repo.save(wf, []);

    const retry = { run: vi.fn().mockResolvedValue({}) } as unknown as RetryTaskService;
    const schedulerService = new SchedulerService({
      repo,
      retry,
      log: silentLogger(),
      signal: controller.signal,
    });

    try {
      schedulerService.attach("wf-detach-race");
      await repo.latestCursorStarted;

      schedulerService.detach("wf-detach-race");
      repo.continueLatestCursor();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(repo.subscriberCount("wf-detach-race")).toBe(0);
      expect(schedulerService.getStats()).toEqual({ attachedWorkflows: 0, inFlight: 0 });
      expect(retry.run).not.toHaveBeenCalled();
    } finally {
      controller.abort();
    }
  });

  it("single-task happy path: pending task dispatched and reaches completed", async () => {
    const repo = new InMemoryWorkflowRepository();
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "ref-1" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });
    const runtime = makeRuntime(1);
    const controller = new AbortController();

    try {
      const wf = createWorkflow({
        id: "wf-single",
        kind: "single-task",
        repoId: "fixture-repo",
        tasks: [{ id: "t1", title: "Task 1", prompt: "do stuff" }],
      }, now);
      await repo.save(wf, []);

      const { schedulerService } = makeServices(repo, provider, runtime, controller.signal);
      schedulerService.attach("wf-single");

      // complete-runtime transitions the task to "completed"
      await waitForStatus(repo, "wf-single", "t1", "completed");

      const finalWf = await repo.get("wf-single");
      expect(finalWf?.graph["t1"]?.executionStatus).toBe("completed");
    } finally {
      controller.abort();
    }
  });

  it("3-task DAG (A→B, A→C): all tasks complete in topological order", async () => {
    const repo = new InMemoryWorkflowRepository();

    // Three frames: one for tA, one for tB, one for tC
    const finalA: ProviderEvent = { kind: "final", sessionRef: "ref-a" };
    const finalB: ProviderEvent = { kind: "final", sessionRef: "ref-b" };
    const finalC: ProviderEvent = { kind: "final", sessionRef: "ref-c" };

    // The StubProviderPlugin uses a counter — each attach/parseFrame call returns the next frame set.
    // Each task's run will call parseFrame once per line yielded by the runtime.
    const provider = new StubProviderPlugin({ frames: [[finalA], [finalB], [finalC]] });
    const runtime = makeRuntime(1);
    const controller = new AbortController();

    try {
      const wf = createWorkflow({
        id: "wf-dag",
        kind: "manual-dag",
        repoId: "fixture-repo",
        tasks: [
          { id: "tA", title: "Task A", prompt: "do A" },
          { id: "tB", title: "Task B", prompt: "do B", dependsOn: ["tA"] },
          { id: "tC", title: "Task C", prompt: "do C", dependsOn: ["tA"] },
        ],
        policy: { maxConcurrent: 3 },
      }, now);
      await repo.save(wf, []);

      const { schedulerService } = makeServices(repo, provider, runtime, controller.signal);
      schedulerService.attach("wf-dag");

      // tA must complete first (complete-runtime → "completed" which is a success status)
      await waitForStatus(repo, "wf-dag", "tA", "completed", 3000);

      // After tA reaches "completed", the task-transitioned event fires
      // and scheduler picks up tB and tC
      await waitForStatus(repo, "wf-dag", "tB", "completed", 3000);
      await waitForStatus(repo, "wf-dag", "tC", "completed", 3000);

      const finalWf = await repo.get("wf-dag");
      const successStatuses = new Set(["completed", "pr-open", "merged"]);
      expect(successStatuses.has(finalWf?.graph["tA"]?.executionStatus ?? "")).toBe(true);
      expect(successStatuses.has(finalWf?.graph["tB"]?.executionStatus ?? "")).toBe(true);
      expect(successStatuses.has(finalWf?.graph["tC"]?.executionStatus ?? "")).toBe(true);
    } finally {
      controller.abort();
    }
  });

  it("re-dispatches recovered pending task via resume path when prior run has providerSessionRef", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-ref" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });
    const resumeSpy = vi.spyOn(provider, "resume");
    const prepareSpy = vi.spyOn(provider, "prepare");
    const controller = new AbortController();

    try {
      // Seed a workflow whose single task was running, then got recovered (sessionId cleared,
      // status back to "pending"), with the prior run's providerSessionRef preserved on the
      // closed run. This is exactly the state boot recovery leaves a task in after detecting
      // a dead tmux session.
      const wf = createSingleTaskWorkflow("wf-resume", { title: "T", prompt: "P" }, now);
      await repo.save(wf, []);
      await applyCommand(repo, {
        kind: "transition-task",
        workflowId: "wf-resume",
        transition: { kind: "mark-ready", taskId: "wf-resume:task", now: NOW },
      });
      await applyCommand(repo, {
        kind: "transition-task",
        workflowId: "wf-resume",
        transition: { kind: "mark-running", taskId: "wf-resume:task", sessionId: "s-old", now: NOW },
      });
      await applyCommand(repo, {
        kind: "transition-task",
        workflowId: "wf-resume",
        transition: { kind: "recover-task", taskId: "wf-resume:task", now: NOW },
      });

      // Inject providerSessionRef on the prior (closed) run — captured before the runtime died.
      const wfCurrent = await repo.get("wf-resume");
      const task = wfCurrent!.graph["wf-resume:task"]!;
      const patchedRun: NodeRun = { ...task.runs[0]!, providerSessionRef: "prior-ref" };
      await repo.save({
        ...wfCurrent!,
        version: wfCurrent!.version + 1,
        graph: { "wf-resume:task": { ...task, runs: [patchedRun] } },
      }, []);

      const dispatchModes: Array<"retry" | "continue"> = [];
      const retryService = new RetryTaskService({
        repo,
        applyCommand: (cmd) => applyCommand(repo, cmd),
        providerFactory: () => provider,
        runtime,
        workspace: new StubWorkspaceBackend(),
        now,
        spawnOrchestrator: () => { dispatchModes.push("retry"); },
      });
      const continueService = new ContinueTaskService({
        repo,
        applyCommand: (cmd) => applyCommand(repo, cmd),
        providerFactory: () => provider,
        runtime,
        workspace: new StubWorkspaceBackend(),
        now,
        spawnOrchestrator: () => { dispatchModes.push("continue"); },
      });

      const schedulerService = new SchedulerService({
        repo,
        retry: retryService,
        continueService,
        log: silentLogger(),
        signal: controller.signal,
      });

      schedulerService.attach("wf-resume");

      // Wait until the task is dispatched (via either path)
      const deadline = Date.now() + 2000;
      while (dispatchModes.length === 0 && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 10));
      }

      expect(dispatchModes).toEqual(["continue"]);
      expect(resumeSpy).toHaveBeenCalledOnce();
      expect(resumeSpy).toHaveBeenCalledWith(expect.objectContaining({ sessionRef: "prior-ref" }));
      expect(prepareSpy).not.toHaveBeenCalled();

      // The new run carries the resumed providerSessionRef.
      const wfAfter = await repo.get("wf-resume");
      const taskAfter = wfAfter!.graph["wf-resume:task"]!;
      const openRun = taskAfter.runs.find((r) => r.endedAt === undefined);
      expect(openRun?.providerSessionRef).toBe("prior-ref");
    } finally {
      controller.abort();
    }
  });

  it("re-dispatches pending task without prior providerSessionRef via retry (fresh) path", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "fresh-ref" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });
    const resumeSpy = vi.spyOn(provider, "resume");
    const prepareSpy = vi.spyOn(provider, "prepare");
    const controller = new AbortController();

    try {
      const wf = createSingleTaskWorkflow("wf-fresh", { title: "T", prompt: "P" }, now);
      await repo.save(wf, []);
      // Pending task with no prior runs at all → should use retry (fresh).

      const dispatchModes: Array<"retry" | "continue"> = [];
      const retryService = new RetryTaskService({
        repo,
        applyCommand: (cmd) => applyCommand(repo, cmd),
        providerFactory: () => provider,
        runtime,
        workspace: new StubWorkspaceBackend(),
        now,
        spawnOrchestrator: () => { dispatchModes.push("retry"); },
      });
      const continueService = new ContinueTaskService({
        repo,
        applyCommand: (cmd) => applyCommand(repo, cmd),
        providerFactory: () => provider,
        runtime,
        workspace: new StubWorkspaceBackend(),
        now,
        spawnOrchestrator: () => { dispatchModes.push("continue"); },
      });

      const schedulerService = new SchedulerService({
        repo,
        retry: retryService,
        continueService,
        log: silentLogger(),
        signal: controller.signal,
      });

      schedulerService.attach("wf-fresh");

      const deadline = Date.now() + 2000;
      while (dispatchModes.length === 0 && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 10));
      }

      expect(dispatchModes).toEqual(["retry"]);
      expect(prepareSpy).toHaveBeenCalledOnce();
      expect(resumeSpy).not.toHaveBeenCalled();
    } finally {
      controller.abort();
    }
  });

  it("does not re-dispatch a task that is already running", async () => {
    const repo = new InMemoryWorkflowRepository();
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "ref-1" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });
    const runtime = makeRuntime(1);
    const controller = new AbortController();
    let spawnCount = 0;

    try {
      const wf = createWorkflow({
        id: "wf-no-redispatch",
        kind: "single-task",
        repoId: "fixture-repo",
        tasks: [{ id: "t1", title: "T", prompt: "P" }],
      }, now);
      await repo.save(wf, []);

      const retryService = new RetryTaskService({
        repo,
        applyCommand: (cmd) => applyCommand(repo, cmd),
        providerFactory: () => provider,
        runtime,
        workspace: new StubWorkspaceBackend(),
        now,
        spawnOrchestrator: () => { spawnCount++; },
      });

      const schedulerService = new SchedulerService({
        repo,
        retry: retryService,
        log: silentLogger(),
        signal: controller.signal,
      });

      schedulerService.attach("wf-no-redispatch");

      // Wait for the task to be dispatched
      await waitForStatus(repo, "wf-no-redispatch", "t1", "running", 2000);

      // Small delay to let any duplicate dispatch fire
      await new Promise<void>((r) => setTimeout(r, 50));

      // spawnCount should be exactly 1
      expect(spawnCount).toBe(1);
    } finally {
      controller.abort();
    }
  });

  it("retries failed dispatches after backoff without needing another workflow event", async () => {
    vi.useFakeTimers();
    const repo = new InMemoryWorkflowRepository();
    const controller = new AbortController();
    const retryRun = vi.fn(async ({ workflowId, taskId }: { workflowId: string; taskId: string }) => {
      await applyCommand(repo, {
        kind: "transition-task",
        workflowId,
        transition: { kind: "mark-ready", taskId, now: NOW },
      });
      throw new Error(`dispatch failure ${retryRun.mock.calls.length}`);
    });
    const retry = {
      run: retryRun,
    } as unknown as RetryTaskService;

    try {
      const wf = createWorkflow({
        id: "wf-backoff",
        kind: "single-task",
        repoId: "fixture-repo",
        tasks: [{ id: "t1", title: "T", prompt: "P" }],
      }, now);
      await repo.save(wf, []);

      const schedulerService = new SchedulerService({
        repo,
        retry,
        applyCommand: (cmd) => applyCommand(repo, cmd),
        log: silentLogger(),
        signal: controller.signal,
        now,
        dispatchBackoffMs: 50,
      });

      schedulerService.attach("wf-backoff");

      await flushMicrotasks();
      expect(retry.run).toHaveBeenCalledTimes(1);
      await flushMicrotasks();
      expect((await repo.get("wf-backoff"))?.graph["t1"]?.executionStatus).toBe("pending");

      await vi.advanceTimersByTimeAsync(0);
      expect(retry.run).toHaveBeenCalledTimes(2);
      await flushMicrotasks();
      expect((await repo.get("wf-backoff"))?.graph["t1"]?.executionStatus).toBe("pending");

      await vi.advanceTimersByTimeAsync(49);
      expect(retry.run).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(retry.run).toHaveBeenCalledTimes(3);
    } finally {
      controller.abort();
      vi.useRealTimers();
    }
  });
});
