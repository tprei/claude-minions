import { describe, expect, it, vi } from "vitest";
import { runBootRecovery } from "../../src/application/boot.js";
import type { BootRespawnContext } from "../../src/application/boot.js";
import { applyCommand } from "../../src/application/commands.js";
import { createRecoveryService } from "../../src/application/recovery-service.js";
import { silentLogger } from "../test-helpers.js";
import { NoopRestackExecutor } from "../../src/application/restack-executor.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { StubProviderPlugin } from "../../src/plugins/providers/stub.js";
import { StubWorkspaceBackend } from "../../src/plugins/workspace/stub-workspace.js";
import { RunOrchestrator } from "../../src/application/run-orchestrator.js";
import type { RunOrchestratorDeps } from "../../src/application/run-orchestrator.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";
import type { RuntimeAttachOptions, RuntimeBackend, RuntimeOutputChunk, RuntimeStartResult, RuntimeStartSpec } from "../../src/plugins/runtime-backend.js";
import type { ProviderEvent } from "../../src/plugins/provider-plugin.js";
import type { RuntimeProbeState } from "../../src/application/recovery.js";

const started = "2026-05-04T11:19:00.000Z";
const staleNow = "2026-05-04T11:21:00.000Z"; // 2 min later, staleReadyMs = 60s

const bootOptions = {
  now: () => staleNow,
  staleReadyMs: 60_000,
  staleGateMs: 300_000,
};

describe("runBootRecovery", () => {
  it("no-op when there are no recoverable workflows", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());

    const report = await runBootRecovery(repo, service, runtime, bootOptions);
    expect(report).toEqual({ workflowsScanned: 0, orchestratorsSpawned: 0, failures: [] });
  });

  it("recovers a stale-ready task back to pending on boot", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    await repo.save(wf, []);
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now: started },
    });

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());
    await runBootRecovery(repo, service, runtime, bootOptions);

    const saved = await repo.get("wf-1");
    expect(saved?.graph["wf-1:task"]?.executionStatus).toBe("pending");
  });

  it("probes runtime for tasks with sessionId", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const probeSpy = vi.spyOn(runtime, "probe");

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    // Manually inject sessionId into a running task
    const taskWithSession = {
      ...wf.graph["wf-1:task"]!,
      executionStatus: "running" as const,
      sessionId: "stub-session-1",
    };
    const wfWithSession = {
      ...wf,
      graph: { "wf-1:task": taskWithSession },
    };
    await repo.save(wfWithSession, []);

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());
    await runBootRecovery(repo, service, runtime, bootOptions);

    expect(probeSpy).toHaveBeenCalledWith("stub-session-1");
  });

  it("cancelled workflow with live sessionId triggers stop on boot", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const stopSpy = vi.spyOn(runtime, "stop");

    // Start a session on the runtime so probe returns "live"
    const { sessionId } = await runtime.start({
      taskId: "wf-1:task",
      workflowId: "wf-1",
      command: ["echo"],
    });

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    // Task is "running" with a session — workflow cancelled but task not yet cancelled
    const taskWithSession = {
      ...wf.graph["wf-1:task"]!,
      executionStatus: "running" as const,
      sessionId,
    };
    const cancelledWf = {
      ...wf,
      status: "cancelled" as const,
      graph: { "wf-1:task": taskWithSession },
    };
    await repo.save(cancelledWf, []);

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());
    await runBootRecovery(repo, service, runtime, bootOptions);

    expect(stopSpy).toHaveBeenCalledWith(sessionId);
  });

  it("second runBootRecovery is idempotent (idempotency rows prevent re-dispatch)", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    await repo.save(wf, []);
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now: started },
    });

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());
    await runBootRecovery(repo, service, runtime, bootOptions);

    const afterFirst = (await repo.eventsSince("wf-1", 0)).length;

    await runBootRecovery(repo, service, runtime, bootOptions);

    const afterSecond = (await repo.eventsSince("wf-1", 0)).length;
    expect(afterSecond).toBe(afterFirst);
  });

  it("isolates probe failures per workflow: one bad session does not block other workflows", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();

    const { sessionId: goodSession } = await runtime.start({
      taskId: "wf-good:task", workflowId: "wf-good", command: ["echo"],
    });

    // wf-bad has a session that probe will fail on
    const wfBad = createSingleTaskWorkflow("wf-bad", { title: "B", prompt: "B" }, () => started);
    const wfBadRunning = {
      ...wfBad,
      graph: {
        "wf-bad:task": { ...wfBad.graph["wf-bad:task"]!, executionStatus: "running" as const, sessionId: "doomed-session" },
      },
    };
    await repo.save(wfBadRunning, []);

    // wf-good has a healthy session
    const wfGood = createSingleTaskWorkflow("wf-good", { title: "G", prompt: "G" }, () => started);
    const wfGoodRunning = {
      ...wfGood,
      graph: {
        "wf-good:task": { ...wfGood.graph["wf-good:task"]!, executionStatus: "running" as const, sessionId: goodSession },
      },
    };
    await repo.save(wfGoodRunning, []);

    vi.spyOn(runtime, "probe").mockImplementation(async (sid) => {
      if (sid === "doomed-session") throw new Error("probe blew up");
      return "live";
    });

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());
    const report = await runBootRecovery(repo, service, runtime, bootOptions);

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.workflowId).toBe("wf-bad");
    expect(report.failures[0]?.phase).toBe("probe");
    expect(report.workflowsScanned).toBe(1);
  });

  it("isolates scan failures per workflow", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    await repo.save(wf, []);
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now: started },
    });

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());
    vi.spyOn(service, "scan").mockRejectedValueOnce(new Error("scan exploded"));

    const report = await runBootRecovery(repo, service, runtime, bootOptions);

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.phase).toBe("scan");
    expect(report.failures[0]?.error).toBe("scan exploded");
    expect(report.workflowsScanned).toBe(0);
  });

  it("missing probe on boot: task ends in needs-review with interrupted run, sessionId cleared", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    await repo.save(wf, []);
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now: started },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-running", taskId: "wf-1:task", sessionId: "s-missing", now: started },
    });

    vi.spyOn(runtime, "probe").mockResolvedValue("missing");

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());
    await runBootRecovery(repo, service, runtime, bootOptions);

    const saved = await repo.get("wf-1");
    const task = saved?.graph["wf-1:task"];
    expect(task?.executionStatus).toBe("needs-review");
    expect(task?.sessionId).toBeUndefined();
    const lastRun = task?.runs[task.runs.length - 1];
    expect(lastRun?.terminalReason).toBe("interrupted");
    expect(lastRun?.runtimeSessionId).toBe("s-missing");
  });

  it("dead probe on boot: task returns to pending (no artifacts) with recovered run", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    await repo.save(wf, []);
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now: started },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-running", taskId: "wf-1:task", sessionId: "s-dead", now: started },
    });

    vi.spyOn(runtime, "probe").mockResolvedValue("dead");

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());
    await runBootRecovery(repo, service, runtime, bootOptions);

    const saved = await repo.get("wf-1");
    const task = saved?.graph["wf-1:task"];
    expect(task?.executionStatus).toBe("pending");
    const lastRun = task?.runs[task.runs.length - 1];
    expect(lastRun?.terminalReason).toBe("recovered");
  });

  it("live runtime probe for a running task produces no recovery action", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();

    const { sessionId } = await runtime.start({
      taskId: "wf-1:task",
      workflowId: "wf-1",
      command: ["echo"],
    });

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    const taskRunning = {
      ...wf.graph["wf-1:task"]!,
      executionStatus: "running" as const,
      sessionId,
    };
    const runningWf = { ...wf, graph: { "wf-1:task": taskRunning } };
    await repo.save(runningWf, []);

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());
    await runBootRecovery(repo, service, runtime, bootOptions);

    const saved = await repo.get("wf-1");
    expect(saved?.graph["wf-1:task"]?.executionStatus).toBe("running");
  });
});

describe("runBootRecovery — spawnOrchestrator", () => {
  it("spawnOrchestrator not invoked when option absent", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const { sessionId } = await runtime.start({ taskId: "wf-1:task", workflowId: "wf-1", command: ["echo"] });

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    const taskRunning = {
      ...wf.graph["wf-1:task"]!,
      executionStatus: "running" as const,
      sessionId,
      runs: [{
        id: "run-wf-1:task-1",
        taskId: "wf-1:task",
        attempt: 1,
        providerType: "stub",
        runtimeType: "stub",
        runtimeSessionId: sessionId,
        startedAt: started,
      }],
    };
    await repo.save({ ...wf, graph: { "wf-1:task": taskRunning } }, []);

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());
    const report = await runBootRecovery(repo, service, runtime, bootOptions);

    expect(report.orchestratorsSpawned).toBe(0);
    expect(report.failures).toHaveLength(0);
  });

  it("spawnOrchestrator not invoked for missing/dead probes", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    const taskRunning = {
      ...wf.graph["wf-1:task"]!,
      executionStatus: "running" as const,
      sessionId: "dead-session",
      runs: [{
        id: "run-wf-1:task-1",
        taskId: "wf-1:task",
        attempt: 1,
        providerType: "stub",
        runtimeType: "stub",
        runtimeSessionId: "dead-session",
        startedAt: started,
      }],
    };
    await repo.save({ ...wf, graph: { "wf-1:task": taskRunning } }, []);

    vi.spyOn(runtime, "probe").mockResolvedValue("dead");

    const spawned: BootRespawnContext[] = [];
    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());
    const report = await runBootRecovery(repo, service, runtime, {
      ...bootOptions,
      spawnOrchestrator: (ctx) => spawned.push(ctx),
    });

    expect(spawned).toHaveLength(0);
    expect(report.orchestratorsSpawned).toBe(0);
  });

  it("ctx populated with runId === openRun.id", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const { sessionId } = await runtime.start({ taskId: "wf-1:task", workflowId: "wf-1", command: ["echo"] });

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    const openRunId = "run-wf-1:task-1";
    const taskRunning = {
      ...wf.graph["wf-1:task"]!,
      executionStatus: "running" as const,
      sessionId,
      runs: [{
        id: openRunId,
        taskId: "wf-1:task",
        attempt: 1,
        providerType: "stub",
        runtimeType: "stub",
        runtimeSessionId: sessionId,
        startedAt: started,
      }],
    };
    await repo.save({ ...wf, graph: { "wf-1:task": taskRunning } }, []);

    const spawned: BootRespawnContext[] = [];
    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());
    await runBootRecovery(repo, service, runtime, {
      ...bootOptions,
      spawnOrchestrator: (ctx) => spawned.push(ctx),
    });

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.runId).toBe(openRunId);
  });

  it("spawnOrchestrator invoked once per live task with correct ctx fields", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const { sessionId } = await runtime.start({ taskId: "wf-1:task", workflowId: "wf-1", command: ["echo"] });

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    const taskRunning = {
      ...wf.graph["wf-1:task"]!,
      executionStatus: "running" as const,
      sessionId,
      runs: [{
        id: "run-wf-1:task-1",
        taskId: "wf-1:task",
        attempt: 1,
        providerType: "stub",
        runtimeType: "tmux",
        runtimeSessionId: sessionId,
        outputOffset: 55,
        providerSessionRef: "ref-123",
        startedAt: started,
      }],
    };
    await repo.save({ ...wf, graph: { "wf-1:task": taskRunning } }, []);

    const spawned: BootRespawnContext[] = [];
    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());
    const report = await runBootRecovery(repo, service, runtime, {
      ...bootOptions,
      spawnOrchestrator: (ctx) => spawned.push(ctx),
    });

    expect(report.orchestratorsSpawned).toBe(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.workflowId).toBe("wf-1");
    expect(spawned[0]?.taskId).toBe("wf-1:task");
    expect(spawned[0]?.runtimeSessionId).toBe(sessionId);
    expect(spawned[0]?.providerType).toBe("stub");
    expect(spawned[0]?.runtimeType).toBe("tmux");
    expect(spawned[0]?.fromOffset).toBe(55);
  });

  it("spawnOrchestrator throw → failures.phase === 'spawn'; orchestratorsSpawned excludes it", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const { sessionId } = await runtime.start({ taskId: "wf-1:task", workflowId: "wf-1", command: ["echo"] });

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    const taskRunning = {
      ...wf.graph["wf-1:task"]!,
      executionStatus: "running" as const,
      sessionId,
      runs: [{
        id: "run-wf-1:task-1",
        taskId: "wf-1:task",
        attempt: 1,
        providerType: "stub",
        runtimeType: "stub",
        runtimeSessionId: sessionId,
        startedAt: started,
      }],
    };
    await repo.save({ ...wf, graph: { "wf-1:task": taskRunning } }, []);

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());
    const report = await runBootRecovery(repo, service, runtime, {
      ...bootOptions,
      spawnOrchestrator: () => { throw new Error("spawn failed"); },
    });

    expect(report.orchestratorsSpawned).toBe(0);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.phase).toBe("spawn");
    expect(report.failures[0]?.error).toBe("spawn failed");
  });

  it("boot does not pass fromOffset when providerSessionRef is undefined on open run", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const { sessionId } = await runtime.start({ taskId: "wf-1:task", workflowId: "wf-1", command: ["echo"] });

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    const taskRunning = {
      ...wf.graph["wf-1:task"]!,
      executionStatus: "running" as const,
      sessionId,
      runs: [{
        id: "run-wf-1:task-1",
        taskId: "wf-1:task",
        attempt: 1,
        providerType: "stub",
        runtimeType: "stub",
        runtimeSessionId: sessionId,
        outputOffset: 50,
        startedAt: started,
      }],
    };
    await repo.save({ ...wf, graph: { "wf-1:task": taskRunning } }, []);

    const spawned: BootRespawnContext[] = [];
    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());
    await runBootRecovery(repo, service, runtime, {
      ...bootOptions,
      spawnOrchestrator: (ctx) => spawned.push(ctx),
    });

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.fromOffset).toBeUndefined();
  });

  it("boot passes fromOffset when both outputOffset and providerSessionRef are set", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const { sessionId } = await runtime.start({ taskId: "wf-1:task", workflowId: "wf-1", command: ["echo"] });

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    const taskRunning = {
      ...wf.graph["wf-1:task"]!,
      executionStatus: "running" as const,
      sessionId,
      runs: [{
        id: "run-wf-1:task-1",
        taskId: "wf-1:task",
        attempt: 1,
        providerType: "stub",
        runtimeType: "stub",
        runtimeSessionId: sessionId,
        outputOffset: 50,
        providerSessionRef: "uuid-session",
        startedAt: started,
      }],
    };
    await repo.save({ ...wf, graph: { "wf-1:task": taskRunning } }, []);

    const spawned: BootRespawnContext[] = [];
    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());
    await runBootRecovery(repo, service, runtime, {
      ...bootOptions,
      spawnOrchestrator: (ctx) => spawned.push(ctx),
    });

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.fromOffset).toBe(50);
  });

  it("acceptance: boot spawns orchestrator for live task; orchestrator settles to completed", async () => {
    const repo = new InMemoryWorkflowRepository();

    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "ref-abc" };

    let attachCalled = false;
    const runtime: RuntimeBackend = {
      async start(_spec: RuntimeStartSpec): Promise<RuntimeStartResult> {
        return { sessionId: "live-session", runtimeType: "stub" };
      },
      async stop(_sessionId: string): Promise<void> {},
      async probe(_sessionId: string): Promise<RuntimeProbeState> {
        return "live";
      },
      attach(_sessionId: string, _opts?: RuntimeAttachOptions): AsyncIterable<RuntimeOutputChunk> {
        attachCalled = true;
        const line = new TextEncoder().encode("event-line\n");
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { sessionId: "live-session", offset: 0, bytes: line };
          },
        };
      },
    };

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    const taskRunning = {
      ...wf.graph["wf-1:task"]!,
      executionStatus: "running" as const,
      sessionId: "live-session",
      runs: [{
        id: "run-wf-1:task-1",
        taskId: "wf-1:task",
        attempt: 1,
        providerType: "stub",
        runtimeType: "stub",
        runtimeSessionId: "live-session",
        startedAt: started,
      }],
    };
    await repo.save({ ...wf, graph: { "wf-1:task": taskRunning } }, []);

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => staleNow, silentLogger());

    const orchestratorDonePromises: Promise<void>[] = [];
    const report = await runBootRecovery(repo, service, runtime, {
      ...bootOptions,
      spawnOrchestrator: (ctx) => {
        const provider = new StubProviderPlugin({ frames: [[finalEvent]] });
        const deps: RunOrchestratorDeps = {
          workflowId: ctx.workflowId,
          taskId: ctx.taskId,
          runId: ctx.runId,
          runtimeSessionId: ctx.runtimeSessionId,
          provider,
          runtime,
          workspace: new StubWorkspaceBackend(),
          workspaceId: ctx.workspaceId ?? "",
          applyCommand: (cmd) => applyCommand(repo, cmd),
          publish: () => {},
          now: () => staleNow,
          log: silentLogger(),
        };
        if (ctx.fromOffset !== undefined) deps.fromOffset = ctx.fromOffset;
        const orch = new RunOrchestrator(deps);
        orchestratorDonePromises.push(orch.run());
      },
    });

    expect(report.orchestratorsSpawned).toBe(1);
    expect(attachCalled).toBe(true);

    await Promise.race([
      Promise.all(orchestratorDonePromises),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000)),
    ]);

    const saved = await repo.get("wf-1");
    expect(saved?.graph["wf-1:task"]?.executionStatus).toBe("completed");
  });
});
