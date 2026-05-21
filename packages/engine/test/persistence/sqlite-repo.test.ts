import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteWorkflowRepository } from "../../src/persistence/sqlite-repo.js";
import type { WorkflowEvent } from "../../src/domain/events.js";
import type { NodeRun } from "../../src/domain/runs.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";

const now = "2026-05-04T11:19:00.000Z";

function makeTempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-test-"));
  return join(dir, "test.db");
}

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

async function collectN(iterable: AsyncIterable<WorkflowEvent>, n: number): Promise<WorkflowEvent[]> {
  const collected: WorkflowEvent[] = [];
  for await (const event of iterable) {
    collected.push(event);
    if (collected.length >= n) break;
  }
  return collected;
}

describe("SQLiteWorkflowRepository", () => {
  let repo: SQLiteWorkflowRepository;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTempPath();
    repo = new SQLiteWorkflowRepository(dbPath);
  });

  afterEach(() => {
    repo.close();
  });

  it("enables WAL, foreign keys, and a busy timeout", () => {
    const pragmas = repo.getPragmas();
    expect(pragmas.journalMode.toLowerCase()).toBe("wal");
    expect(pragmas.busyTimeout).toBeGreaterThanOrEqual(5000);
    expect(pragmas.foreignKeys).toBe(1);
  });

  it("accepts a first save at version 1", async () => {
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await expect(repo.save(workflow, [])).resolves.toBeUndefined();
    const loaded = await repo.get("wf-1");
    expect(loaded?.id).toBe("wf-1");
    expect(loaded?.version).toBe(1);
  });

  it("throws version_conflict when saving with a stale version", async () => {
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, []);

    const stale = { ...workflow, version: 1 };
    await expect(repo.save(stale, [])).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("assigns monotonically increasing cursors starting at 1", async () => {
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, [makeEvent("wf-1"), makeEvent("wf-1")]);

    const events = await repo.eventsSince("wf-1", 0);
    expect(events.map((e) => e.cursor)).toEqual([1, 2]);
  });

  it("continues cursor sequence across multiple saves", async () => {
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, [makeEvent("wf-1")]);
    await repo.save({ ...workflow, version: 2 }, [makeEvent("wf-1")]);

    const events = await repo.eventsSince("wf-1", 0);
    expect(events.map((e) => e.cursor)).toEqual([1, 2]);
  });

  it("eventsSince returns only events strictly after the given cursor", async () => {
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, [makeEvent("wf-1"), makeEvent("wf-1"), makeEvent("wf-1")]);

    const events = await repo.eventsSince("wf-1", 2);
    expect(events).toHaveLength(1);
    expect(events[0]?.cursor).toBe(3);
  });

  it("idempotency roundtrip: lookup returns what was saved", async () => {
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, [], [{ key: "key-abc", resultRef: "op-1" }]);

    await expect(repo.lookupIdempotency("wf-1", "key-abc")).resolves.toBe("op-1");
  });

  it("idempotency keys are scoped per workflow", async () => {
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, [], [{ key: "key-abc", resultRef: "op-1" }]);

    await expect(repo.lookupIdempotency("wf-2", "key-abc")).resolves.toBeUndefined();
  });

  it("lookupIdempotency returns undefined for unknown key", async () => {
    await expect(repo.lookupIdempotency("wf-1", "missing")).resolves.toBeUndefined();
  });

  it("listRecoverable returns non-completed workflows", async () => {
    const wf1 = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    const wf2 = createSingleTaskWorkflow("wf-2", { title: "T2", prompt: "P2" }, () => now);
    await repo.save(wf1, []);
    await repo.save(wf2, []);

    const recoverable = await repo.listRecoverable();
    expect(recoverable.map((w) => w.id).sort()).toEqual(["wf-1", "wf-2"]);
  });

  it("listRecoverable excludes completed workflows", async () => {
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);
    const completed = { ...wf, version: 2, status: "completed" as const };
    await repo.save(completed, []);

    const recoverable = await repo.listRecoverable();
    expect(recoverable).toHaveLength(0);
  });

  it("NodeRun round-trip: runtimeSessionId, providerSessionRef, outputOffset, terminalReason, exitMetadata persist", async () => {
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    const closedRun: NodeRun = {
      id: "run-wf-1:task-1",
      taskId: "wf-1:task",
      attempt: 1,
      providerType: "claude",
      runtimeType: "tmux",
      runtimeSessionId: "rsid-abc",
      providerSessionRef: "psr-xyz",
      outputOffset: 1024,
      startedAt: now,
      endedAt: now,
      terminalReason: "interrupted",
      exitMetadata: {
        recoverySource: "stream_idle_timeout",
        streamIdleAutoRecoveryAttempt: 2,
      },
    };
    const task = wf.graph["wf-1:task"]!;
    const wfWithRun = {
      ...wf,
      graph: { "wf-1:task": { ...task, runs: [closedRun] } },
    };
    await repo.save(wfWithRun, []);
    repo.close();

    const reopened = new SQLiteWorkflowRepository(dbPath);
    try {
      const loaded = await reopened.get("wf-1");
      const loadedRun = loaded?.graph["wf-1:task"]?.runs[0];
      expect(loadedRun?.runtimeSessionId).toBe("rsid-abc");
      expect(loadedRun?.providerSessionRef).toBe("psr-xyz");
      expect(loadedRun?.outputOffset).toBe(1024);
      expect(loadedRun?.terminalReason).toBe("interrupted");
      expect(loadedRun?.exitMetadata).toEqual({
        recoverySource: "stream_idle_timeout",
        streamIdleAutoRecoveryAttempt: 2,
      });
    } finally {
      reopened.close();
    }
  });

  it("durability: data persists after close and reopen", async () => {
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, [makeEvent("wf-1"), makeEvent("wf-1")]);
    await repo.save({ ...workflow, version: 2 }, [makeEvent("wf-1")], [{ key: "idem-1", resultRef: "ref-1" }]);
    repo.close();

    const reopened = new SQLiteWorkflowRepository(dbPath);
    try {
      const loaded = await reopened.get("wf-1");
      expect(loaded?.version).toBe(2);

      const events = await reopened.eventsSince("wf-1", 0);
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.cursor)).toEqual([1, 2, 3]);

      const ref = await reopened.lookupIdempotency("wf-1", "idem-1");
      expect(ref).toBe("ref-1");
    } finally {
      reopened.close();
    }
  });

  it("atomicity: save with conflicting idempotency key throws and leaves state untouched", async () => {
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, [makeEvent("wf-1")], [{ key: "idem-1", resultRef: "ref-1" }]);

    const v2 = { ...wf, version: 2 };
    await expect(
      repo.save(v2, [makeEvent("wf-1")], [{ key: "idem-1", resultRef: "ref-2" }]),
    ).rejects.toMatchObject({ code: "idempotency_collision" });

    // Workflow version and event count must be unchanged (transaction rolled back)
    const loaded = await repo.get("wf-1");
    expect(loaded?.version).toBe(1);

    const events = await repo.eventsSince("wf-1", 0);
    expect(events).toHaveLength(1);
  });

  it("subscribe: replay-then-live works", async () => {
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, [makeEvent("wf-1"), makeEvent("wf-1")]);

    const iter = repo.subscribe("wf-1", 0)[Symbol.asyncIterator]();

    const r1 = await iter.next();
    const r2 = await iter.next();
    expect(r1.value?.cursor).toBe(1);
    expect(r2.value?.cursor).toBe(2);

    const livePromise = iter.next();
    await Promise.resolve();
    await repo.save({ ...workflow, version: 2 }, [makeEvent("wf-1")]);

    const r3 = await livePromise;
    expect(r3.value?.cursor).toBe(3);

    await iter.return?.();
  });

  it("publishTransient: DB events row count increases and cursor advances", async () => {
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
    expect(after[1]?.kind).toBe("provider-event");
    expect(after[1]?.cursor).toBe(2);
  });

  it("subscribe: fromCursor filters replay events", async () => {
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, [makeEvent("wf-1"), makeEvent("wf-1"), makeEvent("wf-1")]);

    const events = await collectN(repo.subscribe("wf-1", 2), 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.cursor).toBe(3);
  });

  it("list returns active workflows ordered newest-first", async () => {
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
    const wf1 = createSingleTaskWorkflow("wf-1", { title: "T1", prompt: "P1" }, () => "2026-01-01T00:00:00.000Z");
    const wf2 = createSingleTaskWorkflow("wf-2", { title: "T2", prompt: "P2" }, () => "2026-01-02T00:00:00.000Z");
    await repo.save(wf1, []);
    const completed = { ...wf2, version: 1, status: "completed" as const };
    await repo.save(completed, []);

    const result = await repo.list({ includeCompleted: true });
    expect(result.map((w) => w.id).sort()).toEqual(["wf-1", "wf-2"]);
  });

  it("list with includeCompleted: true includes failed and cancelled", async () => {
    const wf1 = createSingleTaskWorkflow("wf-1", { title: "T1", prompt: "P1" }, () => now);
    const wf2 = createSingleTaskWorkflow("wf-2", { title: "T2", prompt: "P2" }, () => now);
    const wf3 = createSingleTaskWorkflow("wf-3", { title: "T3", prompt: "P3" }, () => now);
    await repo.save(wf1, []);
    await repo.save({ ...wf2, version: 1, status: "failed" as const }, []);
    await repo.save({ ...wf3, version: 1, status: "cancelled" as const }, []);

    const result = await repo.list({ includeCompleted: true });
    expect(result.map((w) => w.id).sort()).toEqual(["wf-1", "wf-2", "wf-3"]);
  });

  describe("transcript persistence", () => {
    it("appendTranscript then listTranscript returns entries in seq order", async () => {
      await repo.appendTranscript("wf-1", "run-A", now, { kind: "assistant_text", text: "hello" });
      await repo.appendTranscript("wf-1", "run-A", now, { kind: "thinking", text: "reasoning" });
      await repo.appendTranscript("wf-1", "run-A", now, { kind: "tool_call", id: "tc-1", name: "bash", input: { cmd: "ls" } });

      const entries = await repo.listTranscript("wf-1", "run-A");
      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(entries[0]?.providerEvent.kind).toBe("assistant_text");
      expect(entries[1]?.providerEvent.kind).toBe("thinking");
      expect(entries[2]?.providerEvent.kind).toBe("tool_call");
    });

    it("seq is scoped per run_id: run-A and run-B both start at 1", async () => {
      await repo.appendTranscript("wf-1", "run-A", now, { kind: "assistant_text", text: "A1" });
      await repo.appendTranscript("wf-1", "run-A", now, { kind: "assistant_text", text: "A2" });
      await repo.appendTranscript("wf-1", "run-B", now, { kind: "thinking", text: "B1" });

      const runA = await repo.listTranscript("wf-1", "run-A");
      const runB = await repo.listTranscript("wf-1", "run-B");

      expect(runA.map((e) => e.seq)).toEqual([1, 2]);
      expect(runB.map((e) => e.seq)).toEqual([1]);
    });

    it("listTranscript returns empty array for unknown run", async () => {
      const entries = await repo.listTranscript("wf-1", "nonexistent");
      expect(entries).toEqual([]);
    });

    it("payload round-trips through JSON correctly", async () => {
      const event = { kind: "tool_result" as const, id: "tc-1", output: { lines: ["a", "b"] }, isError: false };
      await repo.appendTranscript("wf-1", "run-A", now, event);

      const entries = await repo.listTranscript("wf-1", "run-A");
      expect(entries[0]?.providerEvent).toEqual(event);
    });

    it("delete removes transcripts for the workflow", async () => {
      const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
      await repo.save(workflow, []);
      await repo.appendTranscript("wf-1", "run-A", now, { kind: "assistant_text", text: "secret" });

      await repo.delete("wf-1");

      expect(await repo.listTranscript("wf-1", "run-A")).toEqual([]);
      const row = repo.getDatabase().prepare("SELECT COUNT(*) AS count FROM transcripts WHERE workflow_id = ?").get("wf-1") as { count: number };
      expect(row.count).toBe(0);
    });
  });
});
