import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/application/commands.js";
import { createRecoveryService } from "../src/application/recovery-service.js";
import { NoopRestackExecutor } from "../src/application/restack-executor.js";
import { InMemoryWorkflowRepository } from "../src/application/repository.js";
import type { WorkflowRepository } from "../src/application/repository.js";
import type { RuntimeProbeState } from "../src/application/recovery.js";
import { StubRuntimeBackend } from "../src/plugins/stub-runtime.js";
import { createSingleTaskWorkflow } from "../src/domain/workflow.js";
import { silentLogger } from "./test-helpers.js";

const started = "2026-05-04T11:19:00.000Z";
const nowMs = new Date("2026-05-04T11:21:00.000Z").getTime();

const defaultOptions = {
  nowMs,
  staleReadyMs: 60_000,
  staleGateMs: 300_000,
};

async function seedReady() {
  const repo = new InMemoryWorkflowRepository();
  const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
  await repo.save(workflow, []);
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: "wf-1",
    transition: { kind: "mark-ready", taskId: "wf-1:task", now: started },
  });
  return repo;
}

describe("RecoveryService.scan", () => {
  it("recovers a stale-ready task back to pending", async () => {
    const repo = await seedReady();
    const service = createRecoveryService(repo, new NoopRestackExecutor(), new StubRuntimeBackend(), () => started, silentLogger());

    const results = await service.scan("wf-1", defaultOptions);

    expect(results).toHaveLength(1);
    const saved = await repo.get("wf-1");
    expect(saved?.graph["wf-1:task"]?.executionStatus).toBe("pending");
  });

  it("resumes a pending restack operation to completed via NoopRestackExecutor", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    await repo.save(workflow, []);

    await applyCommand(repo, {
      kind: "request-restack",
      workflowId: "wf-1",
      input: {
        operationId: "op-1",
        ancestorId: "wf-1:task",
        idempotencyKey: "k1",
        now: started,
      },
    });

    const service = createRecoveryService(repo, new NoopRestackExecutor(), new StubRuntimeBackend(), () => started, silentLogger());
    const results = await service.scan("wf-1", defaultOptions);

    expect(results.length).toBeGreaterThanOrEqual(1);
    const saved = await repo.get("wf-1");
    expect(saved?.operations["op-1"]?.status).toBe("completed");
  });

  it("second scan produces zero new events for the same conditions", async () => {
    const repo = await seedReady();
    const service = createRecoveryService(repo, new NoopRestackExecutor(), new StubRuntimeBackend(), () => started, silentLogger());

    await service.scan("wf-1", defaultOptions);

    const beforeCursor = (await repo.eventsSince("wf-1", 0)).length;
    const secondResults = await service.scan("wf-1", defaultOptions);
    const afterCursor = (await repo.eventsSince("wf-1", 0)).length;

    expect(secondResults).toHaveLength(0);
    expect(afterCursor).toBe(beforeCursor);
  });

  it("throws not_found for unknown workflow", async () => {
    const repo = new InMemoryWorkflowRepository();
    const service = createRecoveryService(repo, new NoopRestackExecutor(), new StubRuntimeBackend(), () => started, silentLogger());

    await expect(service.scan("missing", defaultOptions)).rejects.toMatchObject({ code: "not_found" });
  });

  it("records an idempotency key after recovering a stale-ready task", async () => {
    const repo = await seedReady();
    const service = createRecoveryService(repo, new NoopRestackExecutor(), new StubRuntimeBackend(), () => started, silentLogger());

    await service.scan("wf-1", defaultOptions);

    const key = `recovery:wf-1:wf-1:task:recover-task:0`;
    const ref = await repo.lookupIdempotency("wf-1", key);
    expect(ref).toBe("recovery:recover-task:wf-1:task");
  });

  it("scan with missing probe ends task in needs-review with interrupted run", async () => {
    const repo = new InMemoryWorkflowRepository();
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

    const service = createRecoveryService(repo, new NoopRestackExecutor(), new StubRuntimeBackend(), () => started, silentLogger());
    const results = await service.scan("wf-1", {
      ...defaultOptions,
      runtimeProbes: { "s-missing": "missing" as RuntimeProbeState },
    });

    expect(results).toHaveLength(1);
    const saved = await repo.get("wf-1");
    const task = saved?.graph["wf-1:task"];
    expect(task?.executionStatus).toBe("needs-review");
    expect(task?.sessionId).toBeUndefined();
    const lastRun = task?.runs[task.runs.length - 1];
    expect(lastRun?.terminalReason).toBe("interrupted");
  });

  it("second scan with missing probe produces no new results (idempotency)", async () => {
    const repo = new InMemoryWorkflowRepository();
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

    const service = createRecoveryService(repo, new NoopRestackExecutor(), new StubRuntimeBackend(), () => started, silentLogger());
    const options = { ...defaultOptions, runtimeProbes: { "s-missing": "missing" as RuntimeProbeState } };
    await service.scan("wf-1", options);

    const beforeCursor = (await repo.eventsSince("wf-1", 0)).length;
    const secondResults = await service.scan("wf-1", options);
    const afterCursor = (await repo.eventsSince("wf-1", 0)).length;

    expect(secondResults).toHaveLength(0);
    expect(afterCursor).toBe(beforeCursor);
  });

  it("skips dispatch when the idempotency key is pre-recorded", async () => {
    const repo = await seedReady();
    const key = `recovery:wf-1:wf-1:task:recover-task:0`;
    // Seed the idempotency row via save() — recordIdempotency is removed from the interface
    const wf = await repo.get("wf-1");
    await repo.save({ ...wf!, version: wf!.version + 1 }, [], [{ key, resultRef: "recovery:recover-task:wf-1:task" }]);

    const service = createRecoveryService(repo, new NoopRestackExecutor(), new StubRuntimeBackend(), () => started, silentLogger());
    const results = await service.scan("wf-1", defaultOptions);

    expect(results).toHaveLength(0);
    const saved = await repo.get("wf-1");
    expect(saved?.graph["wf-1:task"]?.executionStatus).toBe("ready");
  });

  it("stale-session interrupt-task does not close a task whose session has changed", async () => {
    const inner = new InMemoryWorkflowRepository();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => started);
    await inner.save(wf, []);
    await applyCommand(inner, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now: started },
    });
    await applyCommand(inner, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-running", taskId: "wf-1:task", sessionId: "s-old", now: started },
    });

    const snapshotWithOldSession = await inner.get("wf-1");

    await applyCommand(inner, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "recover-task", taskId: "wf-1:task", now: started },
    });
    await applyCommand(inner, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now: started },
    });
    await applyCommand(inner, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-running", taskId: "wf-1:task", sessionId: "s-new", now: started },
    });

    let firstGet = true;
    const staleScanRepo: WorkflowRepository = {
      get: async (id) => {
        if (firstGet) {
          firstGet = false;
          return snapshotWithOldSession;
        }
        return inner.get(id);
      },
      save: (w, e, i) => inner.save(w, e, i),
      eventsSince: (id, cursor) => inner.eventsSince(id, cursor),
      latestCursor: (id) => inner.latestCursor(id),
      subscribe: (id, cursor) => inner.subscribe(id, cursor),
      publishTransient: (id, event) => inner.publishTransient(id, event),
      lookupIdempotency: (id, key) => inner.lookupIdempotency(id, key),
      listRecoverable: () => inner.listRecoverable(),
      list: (opts) => inner.list(opts),
    };

    const service = createRecoveryService(
      staleScanRepo,
      new NoopRestackExecutor(),
      new StubRuntimeBackend(),
      () => started,
      silentLogger(),
    );

    const results = await service.scan("wf-1", {
      ...defaultOptions,
      runtimeProbes: { "s-old": "missing" as RuntimeProbeState },
    });

    expect(results).toHaveLength(0);
    const saved = await inner.get("wf-1");
    expect(saved?.graph["wf-1:task"]?.executionStatus).toBe("running");
    expect(saved?.graph["wf-1:task"]?.sessionId).toBe("s-new");
  });

  it("stale-session action is a no-op; subsequent valid action in same scan still executes", async () => {
    // Two workflows: wf-1 has a stale-session interrupt-task (no-op), wf-2 has a stale-ready recover.
    // We exercise both actions in a single scan call by using a two-task workflow where task-a
    // has a stale session and task-b is independently stale-ready.
    const inner = new InMemoryWorkflowRepository();

    // Build a two-task workflow with no dependencies.
    const { createWorkflow } = await import("../src/domain/workflow.js");
    const wfSpec = createWorkflow(
      {
        id: "wf-x",
        kind: "manual-dag",
        tasks: [
          { id: "wf-x:a", title: "A", prompt: "A" },
          { id: "wf-x:b", title: "B", prompt: "B" },
        ],
        policy: { maxConcurrent: 2 },
      },
      () => started,
    );
    await inner.save(wfSpec, []);

    // task-a: running with s-old (will be stale when scan fires interrupt-task).
    await applyCommand(inner, {
      kind: "transition-task",
      workflowId: "wf-x",
      transition: { kind: "mark-ready", taskId: "wf-x:a", now: started },
    });
    await applyCommand(inner, {
      kind: "transition-task",
      workflowId: "wf-x",
      transition: { kind: "mark-running", taskId: "wf-x:a", sessionId: "s-old-a", now: started },
    });

    // task-b: ready (stale-ready — will be recovered to pending).
    await applyCommand(inner, {
      kind: "transition-task",
      workflowId: "wf-x",
      transition: { kind: "mark-ready", taskId: "wf-x:b", now: started },
    });

    const snapshotOld = await inner.get("wf-x");

    // Advance the live store: task-a gets a new session (session changed since snapshot).
    await applyCommand(inner, {
      kind: "transition-task",
      workflowId: "wf-x",
      transition: { kind: "recover-task", taskId: "wf-x:a", now: started },
    });
    await applyCommand(inner, {
      kind: "transition-task",
      workflowId: "wf-x",
      transition: { kind: "mark-ready", taskId: "wf-x:a", now: started },
    });
    await applyCommand(inner, {
      kind: "transition-task",
      workflowId: "wf-x",
      transition: { kind: "mark-running", taskId: "wf-x:a", sessionId: "s-new-a", now: started },
    });

    let firstGet = true;
    const staleScanRepo: WorkflowRepository = {
      get: async (id) => {
        if (firstGet) {
          firstGet = false;
          return snapshotOld;
        }
        return inner.get(id);
      },
      save: (w, e, i) => inner.save(w, e, i),
      eventsSince: (id, cursor) => inner.eventsSince(id, cursor),
      latestCursor: (id) => inner.latestCursor(id),
      subscribe: (id, cursor) => inner.subscribe(id, cursor),
      publishTransient: (id, event) => inner.publishTransient(id, event),
      lookupIdempotency: (id, key) => inner.lookupIdempotency(id, key),
      listRecoverable: () => inner.listRecoverable(),
      list: (opts) => inner.list(opts),
    };

    const service = createRecoveryService(
      staleScanRepo,
      new NoopRestackExecutor(),
      new StubRuntimeBackend(),
      () => started,
      silentLogger(),
    );

    const results = await service.scan("wf-x", {
      ...defaultOptions,
      runtimeProbes: { "s-old-a": "missing" as RuntimeProbeState },
    });

    // task-a: stale interrupt was a no-op — still running with s-new-a.
    const saved = await inner.get("wf-x");
    expect(saved?.graph["wf-x:a"]?.executionStatus).toBe("running");
    expect(saved?.graph["wf-x:a"]?.sessionId).toBe("s-new-a");

    // task-b: stale-ready recover DID execute — back to pending.
    expect(saved?.graph["wf-x:b"]?.executionStatus).toBe("pending");
    expect(results).toHaveLength(1);
  });

  it("stale quality-pending → probe-gate → complete-quality-gate{passed:false} with stale artifact", async () => {
    const repo = new InMemoryWorkflowRepository();
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
      transition: { kind: "mark-running", taskId: "wf-1:task", sessionId: "s1", now: started },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "complete-runtime", taskId: "wf-1:task", now: started },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "start-quality-gate", taskId: "wf-1:task", now: started },
    });

    const service = createRecoveryService(repo, new NoopRestackExecutor(), new StubRuntimeBackend(), () => started, silentLogger());
    const results = await service.scan("wf-1", { ...defaultOptions, staleGateMs: 60_000 });

    expect(results).toHaveLength(1);
    const saved = await repo.get("wf-1");
    const task = saved?.graph["wf-1:task"];
    expect(task?.executionStatus).toBe("needs-review");
    const report = task?.artifacts.find((a) => a.kind === "quality-report");
    expect(report).toBeDefined();
    const ref = JSON.parse(report!.ref) as { reason: string };
    expect(ref.reason).toBe("stale-recovery");
  });

  it("probe-gate idempotency: second scan does not re-fire", async () => {
    const repo = new InMemoryWorkflowRepository();
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
      transition: { kind: "mark-running", taskId: "wf-1:task", sessionId: "s1", now: started },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "complete-runtime", taskId: "wf-1:task", now: started },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "start-quality-gate", taskId: "wf-1:task", now: started },
    });

    const service = createRecoveryService(repo, new NoopRestackExecutor(), new StubRuntimeBackend(), () => started, silentLogger());
    const staleOpts = { ...defaultOptions, staleGateMs: 60_000 };
    await service.scan("wf-1", staleOpts);

    const beforeCursor = (await repo.eventsSince("wf-1", 0)).length;
    const secondResults = await service.scan("wf-1", staleOpts);
    const afterCursor = (await repo.eventsSince("wf-1", 0)).length;

    expect(secondResults).toHaveLength(0);
    expect(afterCursor).toBe(beforeCursor);
  });

  it("stale ci-pending → probe-gate → merge-conflict → task ends in needs-review", async () => {
    const repo = new InMemoryWorkflowRepository();
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
      transition: { kind: "mark-running", taskId: "wf-1:task", sessionId: "s1", now: started },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "complete-runtime", taskId: "wf-1:task", now: started },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "start-finalization", taskId: "wf-1:task", now: started },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: {
        kind: "open-review",
        taskId: "wf-1:task",
        artifacts: [{ kind: "pr", ref: "https://github.com/org/repo/pull/1", producedBy: "merge", createdAt: started }],
        now: started,
      },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "start-ci-gate", taskId: "wf-1:task", now: started },
    });

    const service = createRecoveryService(repo, new NoopRestackExecutor(), new StubRuntimeBackend(), () => started, silentLogger());
    const results = await service.scan("wf-1", { ...defaultOptions, staleGateMs: 60_000 });

    expect(results).toHaveLength(1);
    const saved = await repo.get("wf-1");
    const task = saved?.graph["wf-1:task"];
    expect(task?.executionStatus).toBe("needs-review");
    const report = task?.artifacts.find((a) => a.kind === "ci-report");
    expect(report).toBeDefined();
    const ref = JSON.parse(report!.ref) as { reason: string };
    expect(ref.reason).toBe("stale-recovery");
  });
});
