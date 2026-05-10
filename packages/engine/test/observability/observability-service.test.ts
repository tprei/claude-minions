import { describe, expect, it } from "vitest";
import { ObservabilityService } from "../../src/observability/observability-service.js";
import { createLogger } from "../../src/observability/logger.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";
import type { Sink } from "../../src/observability/sinks.js";
import type { LogRecord } from "../../src/observability/types.js";

const NOW = "2026-05-07T10:00:00.000Z";
const WORKFLOW_ID = "wf-obs-1";

class RecordingSink implements Sink {
  records: LogRecord[] = [];
  write(r: LogRecord) { this.records.push(r); }
}

async function makeRepo(workflowId = WORKFLOW_ID): Promise<InMemoryWorkflowRepository> {
  const repo = new InMemoryWorkflowRepository();
  const wf = createSingleTaskWorkflow(workflowId, { title: "T", prompt: "P" }, () => NOW);
  await repo.save(wf, []);
  return repo;
}

function makeService(opts: {
  repo: InMemoryWorkflowRepository;
  sink: RecordingSink;
  level?: "debug" | "info" | "warn" | "error";
  signal?: AbortSignal;
  ctrl?: AbortController;
}) {
  const ctrl = opts.ctrl ?? new AbortController();
  const log = createLogger(opts.level ?? "info", [opts.sink]);
  return {
    service: new ObservabilityService({ workflowRepo: opts.repo, log, signal: ctrl.signal }),
    ctrl,
  };
}

describe("ObservabilityService", () => {
  it("attach is idempotent: calling attach twice yields exactly ONE service-attached log line", async () => {
    const repo = await makeRepo();
    const sink = new RecordingSink();
    const { service, ctrl } = makeService({ repo, sink });

    service.attach(WORKFLOW_ID);
    service.attach(WORKFLOW_ID);

    await new Promise((r) => setImmediate(r));
    ctrl.abort();

    const attached = sink.records.filter((r) => r.kind === "service-attached");
    expect(attached).toHaveLength(1);
  });

  it("task-transitioned event published after attach → logger receives info line with kind and payload", async () => {
    const repo = await makeRepo();
    const sink = new RecordingSink();
    const { service, ctrl } = makeService({ repo, sink });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    const wf = await repo.get(WORKFLOW_ID);
    const taskId = Object.keys(wf!.graph)[0]!;
    await repo.save(
      { ...wf!, version: wf!.version + 1 },
      [{
        cursor: 0,
        workflowId: WORKFLOW_ID,
        occurredAt: NOW,
        kind: "task-transitioned",
        payload: {
          taskId,
          fromExecutionStatus: "pending",
          toExecutionStatus: "ready",
          fromStackStatus: "clean",
          toStackStatus: "clean",
          taskVersion: 1,
        },
      }],
    );

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    const events = sink.records.filter((r) => r.kind === "task-transitioned");
    expect(events).toHaveLength(1);
    expect(events[0]!.msg).toBe("workflow event");
    expect(events[0]!.taskId).toBe(taskId);
  });

  it("provider-event dropped at info level", async () => {
    const repo = await makeRepo();
    const sink = new RecordingSink();
    const { service, ctrl } = makeService({ repo, sink, level: "info" });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    repo.publishTransient(WORKFLOW_ID, {
      cursor: 0,
      workflowId: WORKFLOW_ID,
      occurredAt: NOW,
      kind: "provider-event",
      payload: {
        taskId: `${WORKFLOW_ID}:task`,
        runId: "run-1",
        providerEvent: { kind: "assistant_text", text: "hello" },
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    const providerLogs = sink.records.filter((r) => r.kind === "provider-event");
    expect(providerLogs).toHaveLength(0);
  });

  it("provider-event passes at debug level", async () => {
    const repo = await makeRepo();
    const sink = new RecordingSink();
    const { service, ctrl } = makeService({ repo, sink, level: "debug" });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    repo.publishTransient(WORKFLOW_ID, {
      cursor: 0,
      workflowId: WORKFLOW_ID,
      occurredAt: NOW,
      kind: "provider-event",
      payload: {
        taskId: `${WORKFLOW_ID}:task`,
        runId: "run-1",
        providerEvent: { kind: "assistant_text", text: "hello" },
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    const providerLogs = sink.records.filter((r) => r.kind === "provider-event");
    expect(providerLogs).toHaveLength(1);
  });

  it("merge-phase dropped at info level", async () => {
    const repo = await makeRepo();
    const sink = new RecordingSink();
    const { service, ctrl } = makeService({ repo, sink, level: "info" });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    repo.publishTransient(WORKFLOW_ID, {
      cursor: 0,
      workflowId: WORKFLOW_ID,
      occurredAt: NOW,
      kind: "merge-phase",
      payload: {
        taskId: `${WORKFLOW_ID}:task`,
        phase: "commit",
        status: "started",
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    const mergeLogs = sink.records.filter((r) => r.kind === "merge-phase");
    expect(mergeLogs).toHaveLength(0);
  });

  it("merge-phase passes at debug level", async () => {
    const repo = await makeRepo();
    const sink = new RecordingSink();
    const { service, ctrl } = makeService({ repo, sink, level: "debug" });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    repo.publishTransient(WORKFLOW_ID, {
      cursor: 0,
      workflowId: WORKFLOW_ID,
      occurredAt: NOW,
      kind: "merge-phase",
      payload: {
        taskId: `${WORKFLOW_ID}:task`,
        phase: "commit",
        status: "started",
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    const mergeLogs = sink.records.filter((r) => r.kind === "merge-phase");
    expect(mergeLogs).toHaveLength(1);
  });

  it("detach(workflowId) cancels the iterator: events published after detach are not logged", async () => {
    const repo = await makeRepo();
    const sink = new RecordingSink();
    const { service, ctrl } = makeService({ repo, sink });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    service.detach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    const wf = await repo.get(WORKFLOW_ID);
    const taskId = Object.keys(wf!.graph)[0]!;
    await repo.save(
      { ...wf!, version: wf!.version + 1 },
      [{
        cursor: 0,
        workflowId: WORKFLOW_ID,
        occurredAt: NOW,
        kind: "task-transitioned",
        payload: {
          taskId,
          fromExecutionStatus: "pending",
          toExecutionStatus: "ready",
          fromStackStatus: "clean",
          toStackStatus: "clean",
          taskVersion: 1,
        },
      }],
    );

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    const eventLogs = sink.records.filter((r) => r.kind === "task-transitioned");
    expect(eventLogs).toHaveLength(0);
  });

  it("signal.abort() cancels all attached iterators: events published after abort are not logged", async () => {
    const sharedRepo = new InMemoryWorkflowRepository();
    const wf1 = createSingleTaskWorkflow("wf-sig-1", { title: "T1", prompt: "P1" }, () => NOW);
    const wf2b = createSingleTaskWorkflow("wf-sig-2", { title: "T2", prompt: "P2" }, () => NOW);
    await sharedRepo.save(wf1, []);
    await sharedRepo.save(wf2b, []);

    const sink = new RecordingSink();
    const ctrl = new AbortController();
    const log = createLogger("info", [sink]);
    const service = new ObservabilityService({ workflowRepo: sharedRepo, log, signal: ctrl.signal });

    service.attach("wf-sig-1");
    service.attach("wf-sig-2");
    await new Promise((r) => setImmediate(r));

    ctrl.abort();
    await new Promise((r) => setImmediate(r));

    const beforeCount = sink.records.filter((r) => r.kind === "task-transitioned").length;

    const loaded1 = await sharedRepo.get("wf-sig-1");
    await sharedRepo.save(
      { ...loaded1!, version: loaded1!.version + 1 },
      [{
        cursor: 0,
        workflowId: "wf-sig-1",
        occurredAt: NOW,
        kind: "workflow-status-changed",
        payload: { fromStatus: "active", toStatus: "completed" },
      }],
    );

    await new Promise((r) => setTimeout(r, 50));

    const afterCount = sink.records.filter((r) => r.kind === "workflow-status-changed").length;
    expect(afterCount - beforeCount).toBe(0);
  });

  it("cursor-before-snapshot: publish event A, attach after A, publish event B → observer logs only B", async () => {
    const repo = new InMemoryWorkflowRepository();
    const wf = createSingleTaskWorkflow(WORKFLOW_ID, { title: "T", prompt: "P" }, () => NOW);
    await repo.save(wf, []);

    const wfLoaded = await repo.get(WORKFLOW_ID);
    const taskId = Object.keys(wfLoaded!.graph)[0]!;

    await repo.save(
      { ...wfLoaded!, version: wfLoaded!.version + 1 },
      [{
        cursor: 0,
        workflowId: WORKFLOW_ID,
        occurredAt: NOW,
        kind: "task-transitioned",
        payload: {
          taskId,
          fromExecutionStatus: "pending",
          toExecutionStatus: "ready",
          fromStackStatus: "clean",
          toStackStatus: "clean",
          taskVersion: 1,
          transitionKind: "mark-ready",
        },
      }],
    );

    const sink = new RecordingSink();
    const ctrl = new AbortController();
    const { service } = makeService({ repo, sink, ctrl });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    const wfAfterA = await repo.get(WORKFLOW_ID);
    await repo.save(
      { ...wfAfterA!, version: wfAfterA!.version + 1 },
      [{
        cursor: 0,
        workflowId: WORKFLOW_ID,
        occurredAt: NOW,
        kind: "task-transitioned",
        payload: {
          taskId,
          fromExecutionStatus: "ready",
          toExecutionStatus: "running",
          fromStackStatus: "clean",
          toStackStatus: "clean",
          taskVersion: 2,
          transitionKind: "mark-running",
        },
      }],
    );

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    const transitioned = sink.records.filter((r) => r.kind === "task-transitioned");
    expect(transitioned).toHaveLength(1);
    expect(transitioned[0]!.toExecutionStatus).toBe("running");
  });
});
