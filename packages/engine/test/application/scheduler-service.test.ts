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
import type { Workflow } from "../../src/domain/types.js";
import type { WorkflowRepository } from "../../src/application/repository.js";

const NOW = "2026-05-10T00:00:00.000Z";
const now = () => NOW;

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

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

describe("SchedulerService", () => {
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
});

interface ControlledRepoHooks {
  onGet?: (callIndex: number, workflowId: string) => Promise<Workflow | undefined> | undefined;
}

function wrapRepo(repo: InMemoryWorkflowRepository, hooks: ControlledRepoHooks): WorkflowRepository {
  const realGet = repo.get.bind(repo);
  let getCalls = 0;
  return {
    get: async (workflowId: string): Promise<Workflow | undefined> => {
      const callIndex = getCalls++;
      const override = hooks.onGet?.(callIndex, workflowId);
      if (override !== undefined) return override;
      return realGet(workflowId);
    },
    save: repo.save.bind(repo),
    delete: repo.delete.bind(repo),
    eventsSince: repo.eventsSince.bind(repo),
    latestCursor: repo.latestCursor.bind(repo),
    subscribe: repo.subscribe.bind(repo),
    publishTransient: repo.publishTransient.bind(repo),
    lookupIdempotency: repo.lookupIdempotency.bind(repo),
    listRecoverable: repo.listRecoverable.bind(repo),
    list: repo.list.bind(repo),
    appendTranscript: repo.appendTranscript.bind(repo),
    listTranscript: repo.listTranscript.bind(repo),
  };
}

function callDispatchPending(svc: SchedulerService, workflowId: string): Promise<void> {
  return (svc as unknown as { dispatchPending(id: string): Promise<void> }).dispatchPending(workflowId);
}

describe("SchedulerService — dispatch-race guard (Fix #3)", () => {
  it("two concurrent dispatchPending calls for the same pending task dispatch it only once", async () => {
    const repo = new InMemoryWorkflowRepository();
    const controller = new AbortController();

    try {
      const wf = createWorkflow({
        id: "wf-race",
        kind: "single-task",
        repoId: "fixture-repo",
        tasks: [{ id: "t-race", title: "T", prompt: "P" }],
      }, now);
      await repo.save(wf, []);

      // Both dispatchPending invocations must reach the candidate loop concurrently.
      // The repo.get always resolves the same live (pending) snapshot — there is NO
      // gating that serializes the two calls. Each get is a real async hop, so the
      // two invocations interleave: A's initial get resolves, A enters the loop and
      // synchronously claims the key (has-check + add, no await between them), then A
      // awaits the freshness get; meanwhile B's initial get resolves and B enters the
      // loop, but now sees inFlight.has(key) === true and skips. Without the
      // synchronous claim, both would pass the has-check and dispatch twice.
      const controlledRepo = wrapRepo(repo, {});

      const dispatchCount = { value: 0 };
      const runSpy = vi.fn().mockImplementation(async () => {
        dispatchCount.value++;
        // Never resolve the dispatch promise — keeps the key in inFlight so the
        // second invocation cannot reclaim it via the .finally cleanup.
        await new Promise<void>(() => {});
      });
      const retryService = { run: runSpy } as unknown as RetryTaskService;

      const svc = new SchedulerService({
        repo: controlledRepo,
        retry: retryService,
        log: silentLogger(),
        signal: controller.signal,
      });

      const p1 = callDispatchPending(svc, "wf-race");
      const p2 = callDispatchPending(svc, "wf-race");

      await Promise.all([p1, p2]);

      expect(dispatchCount.value).toBe(1);
      expect(svc.getStats().inFlight).toBe(1);
    } finally {
      controller.abort();
    }
  });

  it("inFlight key is not leaked after a stale (not-pending) freshness validation", async () => {
    const repo = new InMemoryWorkflowRepository();
    const controller = new AbortController();

    try {
      const wf = createWorkflow({
        id: "wf-stale",
        kind: "single-task",
        repoId: "fixture-repo",
        tasks: [{ id: "t-stale", title: "T", prompt: "P" }],
      }, now);
      await repo.save(wf, []);
      // Transition the task to running so the live snapshot is no longer pending.
      await applyCommand(repo, {
        kind: "transition-task",
        workflowId: "wf-stale",
        transition: { kind: "mark-ready", taskId: "t-stale", now: NOW },
      });
      await applyCommand(repo, {
        kind: "transition-task",
        workflowId: "wf-stale",
        transition: { kind: "mark-running", taskId: "t-stale", sessionId: "s-stale", now: NOW },
      });

      // First get (planDispatch) returns a stale pending snapshot so a candidate is
      // produced; the freshness re-read returns the live (running) snapshot so
      // validation fails and the key must be released.
      const stalePending = createWorkflow({
        id: "wf-stale",
        kind: "single-task",
        repoId: "fixture-repo",
        tasks: [{ id: "t-stale", title: "T", prompt: "P" }],
      }, now);

      const controlledRepo = wrapRepo(repo, {
        onGet: (callIndex) => (callIndex === 0 ? Promise.resolve(stalePending) : undefined),
      });

      const runSpy = vi.fn().mockResolvedValue(undefined);
      const retryService = { run: runSpy } as unknown as RetryTaskService;

      const svc = new SchedulerService({
        repo: controlledRepo,
        retry: retryService,
        log: silentLogger(),
        signal: controller.signal,
      });

      await callDispatchPending(svc, "wf-stale");

      expect(svc.getStats().inFlight).toBe(0);
      expect(runSpy).not.toHaveBeenCalled();
    } finally {
      controller.abort();
    }
  });

  it("inFlight key is not leaked when the freshness re-read THROWS, and the task can be dispatched on a later call", async () => {
    const repo = new InMemoryWorkflowRepository();
    const controller = new AbortController();

    try {
      const wf = createWorkflow({
        id: "wf-throw",
        kind: "single-task",
        repoId: "fixture-repo",
        tasks: [{ id: "t-throw", title: "T", prompt: "P" }],
      }, now);
      await repo.save(wf, []);

      // get call #0 = planDispatch (live pending), #1 = freshness re-read (THROWS),
      // subsequent calls fall through to the real live snapshot.
      const controlledRepo = wrapRepo(repo, {
        onGet: (callIndex) =>
          callIndex === 1 ? Promise.reject(new Error("SQLITE_BUSY")) : undefined,
      });

      const runSpy = vi.fn().mockImplementation(async () => {});
      const retryService = { run: runSpy } as unknown as RetryTaskService;

      const svc = new SchedulerService({
        repo: controlledRepo,
        retry: retryService,
        log: silentLogger(),
        signal: controller.signal,
      });

      // First call: freshness read throws → key must be released, no dispatch.
      await callDispatchPending(svc, "wf-throw");
      expect(svc.getStats().inFlight).toBe(0);
      expect(runSpy).not.toHaveBeenCalled();

      // Second call: reads succeed → the task is still pending and dispatches.
      await callDispatchPending(svc, "wf-throw");
      expect(runSpy).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
    }
  });
});

describe("SchedulerService — failures Map pruning (Fix #2)", () => {
  it("records backoff on transient dispatch failure and does NOT prune it on a re-evaluation while the workflow is still active", async () => {
    const repo = new InMemoryWorkflowRepository();
    const controller = new AbortController();

    try {
      const wf = createWorkflow({
        id: "wf-keep-backoff",
        kind: "single-task",
        repoId: "fixture-repo",
        tasks: [{ id: "t-keep", title: "T", prompt: "P" }],
      }, now);
      await repo.save(wf, []);

      const runSpy = vi.fn().mockRejectedValue(new Error("transient failure"));
      const retryService = { run: runSpy } as unknown as RetryTaskService;

      const svc = new SchedulerService({
        repo,
        retry: retryService,
        log: silentLogger(),
        signal: controller.signal,
        dispatchBackoffMs: 60_000,
      });

      // Dispatch twice so the same failure signature accrues a backoff window.
      await callDispatchPending(svc, "wf-keep-backoff");
      await waitFor(() => svc.getStats().inFlight === 0 && runSpy.mock.calls.length === 1);
      await callDispatchPending(svc, "wf-keep-backoff");
      await waitFor(() => svc.getStats().inFlight === 0 && runSpy.mock.calls.length === 2);

      // Backoff is now recorded; a failure entry exists.
      expect(svc.getStats().failures).toBe(1);

      // Re-evaluate while the workflow is still active — the entry must survive.
      await callDispatchPending(svc, "wf-keep-backoff");
      expect(svc.getStats().failures).toBe(1);
    } finally {
      controller.abort();
    }
  });

  it("prunes a workflow's failure entries when the workflow is gone (deleted)", async () => {
    const repo = new InMemoryWorkflowRepository();
    const controller = new AbortController();

    try {
      const wf = createWorkflow({
        id: "wf-gone",
        kind: "single-task",
        repoId: "fixture-repo",
        tasks: [{ id: "t-gone", title: "T", prompt: "P" }],
      }, now);
      await repo.save(wf, []);

      const runSpy = vi.fn().mockRejectedValue(new Error("transient failure"));
      const retryService = { run: runSpy } as unknown as RetryTaskService;

      const svc = new SchedulerService({
        repo,
        retry: retryService,
        log: silentLogger(),
        signal: controller.signal,
        dispatchBackoffMs: 60_000,
      });

      await callDispatchPending(svc, "wf-gone");
      await waitFor(() => svc.getStats().inFlight === 0 && runSpy.mock.calls.length === 1);
      expect(svc.getStats().failures).toBe(1);

      // Delete the workflow, then re-evaluate — the gone workflow triggers pruning.
      await repo.delete("wf-gone");
      await callDispatchPending(svc, "wf-gone");

      expect(svc.getStats().failures).toBe(0);
    } finally {
      controller.abort();
    }
  });

  it("prunes a workflow's failure entries when the workflow reaches a terminal status", async () => {
    const repo = new InMemoryWorkflowRepository();
    const controller = new AbortController();

    try {
      const wf = createWorkflow({
        id: "wf-terminal",
        kind: "single-task",
        repoId: "fixture-repo",
        tasks: [{ id: "t-term", title: "T", prompt: "P" }],
      }, now);
      await repo.save(wf, []);

      const runSpy = vi.fn().mockRejectedValue(new Error("transient failure"));
      const retryService = { run: runSpy } as unknown as RetryTaskService;

      const svc = new SchedulerService({
        repo,
        retry: retryService,
        log: silentLogger(),
        signal: controller.signal,
        dispatchBackoffMs: 60_000,
      });

      await callDispatchPending(svc, "wf-terminal");
      await waitFor(() => svc.getStats().inFlight === 0 && runSpy.mock.calls.length === 1);
      expect(svc.getStats().failures).toBe(1);

      // Drive the workflow to a terminal (cancelled) status, then re-evaluate.
      await applyCommand(repo, {
        kind: "transition-task",
        workflowId: "wf-terminal",
        transition: { kind: "cancel-task", taskId: "t-term", now: NOW },
      });
      const terminal = await repo.get("wf-terminal");
      expect(terminal?.status).not.toBe("active");

      await callDispatchPending(svc, "wf-terminal");
      expect(svc.getStats().failures).toBe(0);
    } finally {
      controller.abort();
    }
  });
});
