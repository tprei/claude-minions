import { describe, expect, it } from "vitest";
import { SchedulerService } from "../../src/application/scheduler-service.js";
import { RetryTaskService } from "../../src/application/retry-task-service.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createWorkflow } from "../../src/domain/workflow.js";
import { StubProviderPlugin } from "../../src/plugins/providers/stub.js";
import { StubWorkspaceBackend } from "../../src/plugins/workspace/stub-workspace.js";
import { silentLogger } from "../test-helpers.js";
import type { RuntimeAttachOptions, RuntimeBackend, RuntimeOutputChunk, RuntimeStartResult, RuntimeStartSpec } from "../../src/plugins/runtime-backend.js";
import type { RuntimeProbeState } from "../../src/application/recovery.js";
import type { ProviderEvent } from "../../src/plugins/provider-plugin.js";
import { RunOrchestrator } from "../../src/application/run-orchestrator.js";
import { applyCommand } from "../../src/application/commands.js";

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
