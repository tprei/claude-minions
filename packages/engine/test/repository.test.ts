import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRepository } from "../src/application/repository.js";
import { DomainError } from "../src/domain/errors.js";
import type { WorkflowEvent } from "../src/domain/events.js";
import { createSingleTaskWorkflow } from "../src/domain/workflow.js";

const now = "2026-05-04T11:19:00.000Z";

function makeEvent(workflowId: string): WorkflowEvent {
  return {
    cursor: 0,
    workflowId,
    kind: "task-transitioned",
    occurredAt: now,
    payload: {
      taskId: "t",
      fromExecutionStatus: "pending",
      toExecutionStatus: "ready",
      fromStackStatus: "clean",
      toStackStatus: "clean",
      taskVersion: 1,
    },
  };
}

describe("InMemoryWorkflowRepository", () => {
  it("accepts a first save at version 1", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await expect(repo.save(workflow, [])).resolves.toBeUndefined();
    await expect(repo.get("wf-1")).resolves.toBe(workflow);
  });

  it("throws version_conflict when saving with a stale version", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, []);

    const stale = { ...workflow, version: 1 };
    await expect(repo.save(stale, [])).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("assigns monotonically increasing cursors starting at 1", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, [makeEvent("wf-1"), makeEvent("wf-1")]);

    const events = await repo.eventsSince("wf-1", 0);
    expect(events.map((e) => e.cursor)).toEqual([1, 2]);
  });

  it("continues cursor sequence across multiple saves", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, [makeEvent("wf-1")]);
    await repo.save({ ...workflow, version: 2 }, [makeEvent("wf-1")]);

    const events = await repo.eventsSince("wf-1", 0);
    expect(events.map((e) => e.cursor)).toEqual([1, 2]);
  });

  it("eventsSince returns only events strictly after the given cursor", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, [makeEvent("wf-1"), makeEvent("wf-1"), makeEvent("wf-1")]);

    const events = await repo.eventsSince("wf-1", 2);
    expect(events).toHaveLength(1);
    expect(events[0]?.cursor).toBe(3);
  });

  it("idempotency roundtrip: lookup returns what was saved via save()", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, [], [{ key: "key-abc", resultRef: "op-1" }]);

    await expect(repo.lookupIdempotency("wf-1", "key-abc")).resolves.toBe("op-1");
  });

  it("idempotency keys are scoped per workflow", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, [], [{ key: "key-abc", resultRef: "op-1" }]);

    await expect(repo.lookupIdempotency("wf-2", "key-abc")).resolves.toBeUndefined();
  });

  it("lookupIdempotency returns undefined for unknown key", async () => {
    const repo = new InMemoryWorkflowRepository();
    await expect(repo.lookupIdempotency("wf-1", "missing")).resolves.toBeUndefined();
  });

  it("rejects save when version is not exactly one more than existing", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, []);

    const skipped = { ...workflow, version: 3 };
    await expect(repo.save(skipped, [])).rejects.toBeInstanceOf(DomainError);
  });

  it("listRecoverable returns workflows with non-completed status", async () => {
    const repo = new InMemoryWorkflowRepository();
    const wf1 = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    const wf2 = createSingleTaskWorkflow("wf-2", { title: "T2", prompt: "P2" }, () => now);
    await repo.save(wf1, []);
    await repo.save(wf2, []);

    const recoverable = await repo.listRecoverable();
    expect(recoverable.map((w) => w.id).sort()).toEqual(["wf-1", "wf-2"]);
  });

  it("listRecoverable excludes completed workflows", async () => {
    const repo = new InMemoryWorkflowRepository();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);
    const completed = { ...wf, version: 2, status: "completed" as const };
    await repo.save(completed, []);

    const recoverable = await repo.listRecoverable();
    expect(recoverable).toHaveLength(0);
  });

  it("publishTransient appends a durable event with the next cursor", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, [makeEvent("wf-1")]);

    const before = await repo.eventsSince("wf-1", 0);
    expect(before).toHaveLength(1);

    const transient: WorkflowEvent = {
      cursor: 0,
      workflowId: "wf-1",
      kind: "provider-event",
      occurredAt: now,
      payload: { taskId: "t", runId: "run-1", providerEvent: { kind: "assistant_text", text: "hi" } },
    };
    repo.publishTransient("wf-1", transient);

    const after = await repo.eventsSince("wf-1", 0);
    expect(after).toHaveLength(2);
    expect(after[0]?.kind).toBe("task-transitioned");
    expect(after[1]?.kind).toBe("provider-event");
    expect(after[1]?.cursor).toBe(2);
  });

  it("publishTransient: live subscriber receives the durable frame", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, []);

    const iter = repo.subscribe("wf-1", 0)[Symbol.asyncIterator]();

    // Start waiting for first event, then publish transient
    const nextPromise = iter.next();
    await Promise.resolve();

    const transient: WorkflowEvent = {
      cursor: 0,
      workflowId: "wf-1",
      kind: "provider-event",
      occurredAt: now,
      payload: { taskId: "t", runId: "run-1", providerEvent: { kind: "thinking", text: "reasoning" } },
    };
    repo.publishTransient("wf-1", transient);

    const result = await nextPromise;
    expect(result.value?.kind).toBe("provider-event");
    expect(result.value?.cursor).toBe(1);

    await iter.return?.();
  });

  it("list returns active workflows ordered newest-first", async () => {
    const repo = new InMemoryWorkflowRepository();
    const wf1 = createSingleTaskWorkflow("wf-1", { title: "T1", prompt: "P1" }, () => "2026-01-01T00:00:00.000Z");
    const wf2 = createSingleTaskWorkflow("wf-2", { title: "T2", prompt: "P2" }, () => "2026-01-03T00:00:00.000Z");
    const wf3 = createSingleTaskWorkflow("wf-3", { title: "T3", prompt: "P3" }, () => "2026-01-02T00:00:00.000Z");
    await repo.save(wf1, []);
    await repo.save(wf2, []);
    await repo.save(wf3, []);

    const result = await repo.list();
    expect(result.map((w) => w.id)).toEqual(["wf-2", "wf-3", "wf-1"]);
  });

  it("list excludes terminal statuses by default", async () => {
    const repo = new InMemoryWorkflowRepository();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);

    const completed = { ...wf, version: 2, status: "completed" as const };
    await repo.save(completed, []);
    expect(await repo.list()).toHaveLength(0);

    const wf2 = createSingleTaskWorkflow("wf-2", { title: "T2", prompt: "P2" }, () => now);
    await repo.save(wf2, []);
    const failed = { ...wf2, version: 2, status: "failed" as const };
    await repo.save(failed, []);
    expect(await repo.list()).toHaveLength(0);

    const wf3 = createSingleTaskWorkflow("wf-3", { title: "T3", prompt: "P3" }, () => now);
    await repo.save(wf3, []);
    const cancelled = { ...wf3, version: 2, status: "cancelled" as const };
    await repo.save(cancelled, []);
    expect(await repo.list()).toHaveLength(0);
  });

  it("list includes completed workflows with includeCompleted: true", async () => {
    const repo = new InMemoryWorkflowRepository();
    const wf1 = createSingleTaskWorkflow("wf-1", { title: "T1", prompt: "P1" }, () => "2026-01-01T00:00:00.000Z");
    const wf2 = createSingleTaskWorkflow("wf-2", { title: "T2", prompt: "P2" }, () => "2026-01-02T00:00:00.000Z");
    await repo.save(wf1, []);
    const completed = { ...wf2, version: 1, status: "completed" as const };
    await repo.save(completed, []);

    const result = await repo.list({ includeCompleted: true });
    expect(result.map((w) => w.id).sort()).toEqual(["wf-1", "wf-2"]);
  });

  it("list with includeCompleted: true includes failed and cancelled", async () => {
    const repo = new InMemoryWorkflowRepository();
    const wf1 = createSingleTaskWorkflow("wf-1", { title: "T1", prompt: "P1" }, () => now);
    const wf2 = createSingleTaskWorkflow("wf-2", { title: "T2", prompt: "P2" }, () => now);
    const wf3 = createSingleTaskWorkflow("wf-3", { title: "T3", prompt: "P3" }, () => now);
    await repo.save(wf1, []);
    await repo.save({ ...wf2, version: 1, status: "failed" as const }, []);
    await repo.save({ ...wf3, version: 1, status: "cancelled" as const }, []);

    const result = await repo.list({ includeCompleted: true });
    expect(result.map((w) => w.id).sort()).toEqual(["wf-1", "wf-2", "wf-3"]);
  });

  it("delete removes the workflow and its events from the store", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, [makeEvent("wf-1")]);

    expect(await repo.get("wf-1")).toBeDefined();
    expect(await repo.eventsSince("wf-1", 0)).toHaveLength(1);

    await repo.delete("wf-1");

    expect(await repo.get("wf-1")).toBeUndefined();
    expect(await repo.eventsSince("wf-1", 0)).toHaveLength(0);
  });

  it("delete is a no-op when the workflow does not exist", async () => {
    const repo = new InMemoryWorkflowRepository();
    await expect(repo.delete("nonexistent")).resolves.toBeUndefined();
  });

  describe("transcript persistence", () => {
    it("appendTranscript then listTranscript returns entries in seq order", async () => {
      const repo = new InMemoryWorkflowRepository();
      await repo.appendTranscript("wf-1", "run-A", now, { kind: "assistant_text", text: "hi" });
      await repo.appendTranscript("wf-1", "run-A", now, { kind: "thinking", text: "hmm" });
      await repo.appendTranscript("wf-1", "run-A", now, { kind: "tool_call", id: "tc-1", name: "bash", input: {} });

      const entries = await repo.listTranscript("wf-1", "run-A");
      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(entries[0]?.providerEvent.kind).toBe("assistant_text");
      expect(entries[2]?.providerEvent.kind).toBe("tool_call");
    });

    it("seq is scoped per run_id: run-A and run-B both start at 1", async () => {
      const repo = new InMemoryWorkflowRepository();
      await repo.appendTranscript("wf-1", "run-A", now, { kind: "assistant_text", text: "A1" });
      await repo.appendTranscript("wf-1", "run-A", now, { kind: "assistant_text", text: "A2" });
      await repo.appendTranscript("wf-1", "run-B", now, { kind: "thinking", text: "B1" });
      await repo.appendTranscript("wf-1", "run-B", now, { kind: "thinking", text: "B2" });

      const runA = await repo.listTranscript("wf-1", "run-A");
      const runB = await repo.listTranscript("wf-1", "run-B");

      expect(runA.map((e) => e.seq)).toEqual([1, 2]);
      expect(runB.map((e) => e.seq)).toEqual([1, 2]);
    });

    it("listTranscript returns empty array for unknown run", async () => {
      const repo = new InMemoryWorkflowRepository();
      const entries = await repo.listTranscript("wf-1", "nonexistent");
      expect(entries).toEqual([]);
    });
  });

  it("listRecoverable INCLUDES completed workflows that hold a pending or running graph operation", async () => {
    const repo = new InMemoryWorkflowRepository();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);
    const completedWithOp = {
      ...wf,
      version: 2,
      status: "completed" as const,
      operations: {
        "op-1": {
          id: "op-1",
          workflowId: "wf-1",
          kind: "restack" as const,
          targetNodeId: "wf-1:task",
          affectedNodeIds: ["wf-1:task"],
          status: "pending" as const,
          attempt: 0,
          idempotencyKey: "k1",
          createdAt: now,
          updatedAt: now,
        },
      },
    };
    await repo.save(completedWithOp, []);

    const recoverable = await repo.listRecoverable();
    expect(recoverable.map((w) => w.id)).toEqual(["wf-1"]);
  });
});
