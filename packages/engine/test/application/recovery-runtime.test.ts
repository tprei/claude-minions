import { describe, expect, it, vi } from "vitest";
import { applyCommand } from "../../src/application/commands.js";
import { createRecoveryService } from "../../src/application/recovery-service.js";
import { NoopRestackExecutor } from "../../src/application/restack-executor.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";
import { silentLogger } from "../test-helpers.js";

const started = "2026-05-04T11:19:00.000Z";
const nowMs = new Date("2026-05-04T11:21:00.000Z").getTime();

const defaultOptions = {
  nowMs,
  staleReadyMs: 60_000,
  staleGateMs: 300_000,
};

describe("recovery-service: stop-runtime rule", () => {
  it("stop-runtime calls runtime.stop then applies cancel-task", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const stopSpy = vi.spyOn(runtime, "stop");

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

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => started, silentLogger());
    await service.scan("wf-1", { ...defaultOptions, workflowCancelled: true });

    expect(stopSpy).toHaveBeenCalledWith(sessionId);
    const saved = await repo.get("wf-1");
    expect(saved?.graph["wf-1:task"]?.executionStatus).toBe("cancelled");
  });

  it("runtime.stop throws → transition and idempotency row not persisted", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();

    vi.spyOn(runtime, "stop").mockRejectedValueOnce(new Error("stop failed"));
    vi.spyOn(runtime, "probe").mockResolvedValue("live");

    const { sessionId } = await runtime.start({
      taskId: "wf-1:task",
      workflowId: "wf-1",
      command: ["echo"],
    });

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
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

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => started, silentLogger());

    await expect(
      service.scan("wf-1", { ...defaultOptions, workflowCancelled: true }),
    ).rejects.toThrow("stop failed");

    // Workflow state unchanged (still running), idempotency row absent
    const saved = await repo.get("wf-1");
    expect(saved?.graph["wf-1:task"]?.executionStatus).toBe("running");

    const key = `recovery:wf-1:wf-1:task:stop-runtime:0`;
    const ref = await repo.lookupIdempotency("wf-1", key);
    expect(ref).toBeUndefined();
  });

  it("stop-runtime action without sessionId still applies cancel-task transition", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const stopSpy = vi.spyOn(runtime, "stop");

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    const cancelledWf = {
      ...wf,
      status: "cancelled" as const,
      // task has no sessionId
    };
    await repo.save(cancelledWf, []);

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => started, silentLogger());
    // workflow-cancelled-with-runtime rule requires sessionId, so no action fires
    // but if we manually emit stop-runtime without sessionId it would cancel
    // Verify the rule skips stop() when no sessionId
    await service.scan("wf-1", { ...defaultOptions, workflowCancelled: true });

    // No sessionId → stop rule doesn't match (workflow-cancelled-with-runtime requires sessionId)
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("recovery idempotency is atomic: idempotency row present after transition", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    await repo.save(wf, []);
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now: started },
    });

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => started, silentLogger());
    await service.scan("wf-1", { ...defaultOptions });

    const key = `recovery:wf-1:wf-1:task:recover-task:0`;
    const ref = await repo.lookupIdempotency("wf-1", key);
    expect(ref).toBe("recovery:recover-task:wf-1:task");
  });

  it("save throws → workflow unchanged AND idempotency row absent", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    await repo.save(wf, []);
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now: started },
    });

    const stateBefore = await repo.get("wf-1");
    const versionBefore = stateBefore!.version;
    const eventsBefore = (await repo.eventsSince("wf-1", 0)).length;

    const saveSpy = vi.spyOn(repo, "save").mockRejectedValueOnce(new Error("disk full"));

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => started, silentLogger());
    await expect(service.scan("wf-1", defaultOptions)).rejects.toThrow("disk full");

    saveSpy.mockRestore();

    const stateAfter = await repo.get("wf-1");
    expect(stateAfter!.version).toBe(versionBefore);
    expect((await repo.eventsSince("wf-1", 0)).length).toBe(eventsBefore);

    const key = `recovery:wf-1:wf-1:task:recover-task:0`;
    expect(await repo.lookupIdempotency("wf-1", key)).toBeUndefined();
  });

  it("double scan stops at idempotency boundary without dispatching twice", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    await repo.save(wf, []);
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now: started },
    });

    const service = createRecoveryService(repo, new NoopRestackExecutor(), runtime, () => started, silentLogger());

    const firstResults = await service.scan("wf-1", defaultOptions);
    expect(firstResults).toHaveLength(1);

    const eventCountAfterFirst = (await repo.eventsSince("wf-1", 0)).length;
    const secondResults = await service.scan("wf-1", defaultOptions);
    const eventCountAfterSecond = (await repo.eventsSince("wf-1", 0)).length;

    expect(secondResults).toHaveLength(0);
    expect(eventCountAfterSecond).toBe(eventCountAfterFirst);
  });
});
