import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/application/commands.js";
import { InMemoryWorkflowRepository } from "../src/application/repository.js";
import type { WorkflowEvent } from "../src/domain/events.js";
import { createSingleTaskWorkflow } from "../src/domain/workflow.js";

const now = "2026-05-04T11:19:00.000Z";
const taskId = "wf-1:task";

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

async function seedWorkflow(repo: InMemoryWorkflowRepository, id = "wf-1") {
  const workflow = createSingleTaskWorkflow(id, { title: "T", prompt: "P" }, () => now);
  await repo.save(workflow, []);
  return workflow;
}

async function collectN(iterable: AsyncIterable<WorkflowEvent>, n: number): Promise<WorkflowEvent[]> {
  const collected: WorkflowEvent[] = [];
  for await (const event of iterable) {
    collected.push(event);
    if (collected.length >= n) break;
  }
  return collected;
}

describe("InMemoryWorkflowRepository.subscribe", () => {
  it("pure replay: yields all persisted events then blocks", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = await seedWorkflow(repo);
    await repo.save({ ...workflow, version: 2 }, [makeEvent("wf-1"), makeEvent("wf-1")]);

    const events = await collectN(repo.subscribe("wf-1", 0), 2);
    expect(events).toHaveLength(2);
    expect(events[0]?.cursor).toBe(1);
    expect(events[1]?.cursor).toBe(2);
  });

  it("pure live: subscribe then save arrives", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = await seedWorkflow(repo);

    const iterable = repo.subscribe("wf-1", 0);

    const collectPromise = collectN(iterable, 1);

    // Let subscribe register, then save in next microtask
    await Promise.resolve();
    await repo.save({ ...workflow, version: 2 }, [makeEvent("wf-1")]);

    const events = await collectPromise;
    expect(events).toHaveLength(1);
    expect(events[0]?.cursor).toBe(1);
  });

  it("replay-then-live: collects replay events then receives new live event", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = await seedWorkflow(repo);
    await repo.save({ ...workflow, version: 2 }, [makeEvent("wf-1"), makeEvent("wf-1")]);

    const iter = repo.subscribe("wf-1", 0)[Symbol.asyncIterator]();

    // Collect 2 replay events
    const r1 = await iter.next();
    const r2 = await iter.next();
    expect(r1.value?.cursor).toBe(1);
    expect(r2.value?.cursor).toBe(2);

    // Now save a new event — get the 3rd live
    const current = await repo.get("wf-1");
    const livePromise = iter.next();
    await Promise.resolve();
    await repo.save({ ...current!, version: 3 }, [makeEvent("wf-1")]);

    const r3 = await livePromise;
    expect(r3.value?.cursor).toBe(3);

    await iter.return?.();
  });

  it("fromCursor filter: only yields events strictly after given cursor", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = await seedWorkflow(repo);
    await repo.save({ ...workflow, version: 2 }, [
      makeEvent("wf-1"),
      makeEvent("wf-1"),
      makeEvent("wf-1"),
      makeEvent("wf-1"),
      makeEvent("wf-1"),
    ]);

    const events = await collectN(repo.subscribe("wf-1", 3), 2);
    expect(events).toHaveLength(2);
    expect(events[0]?.cursor).toBe(4);
    expect(events[1]?.cursor).toBe(5);
  });

  it("multiple subscribers: both receive all events independently", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = await seedWorkflow(repo);

    const sub1 = repo.subscribe("wf-1", 0);
    const sub2 = repo.subscribe("wf-1", 0);

    const p1 = collectN(sub1, 1);
    const p2 = collectN(sub2, 1);

    await Promise.resolve();
    await repo.save({ ...workflow, version: 2 }, [makeEvent("wf-1")]);

    const [events1, events2] = await Promise.all([p1, p2]);
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
    expect(events1[0]?.cursor).toBe(1);
    expect(events2[0]?.cursor).toBe(1);
  });

  it("replay-during-write race: no duplicates even if save happens during replay", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = await seedWorkflow(repo);
    // Save 2 events before subscribe
    await repo.save({ ...workflow, version: 2 }, [makeEvent("wf-1"), makeEvent("wf-1")]);

    const iter = repo.subscribe("wf-1", 0)[Symbol.asyncIterator]();

    // Get first event (still in replay phase)
    const first = await iter.next();
    expect(first.value?.cursor).toBe(1);

    // Save another event while still mid-replay — this goes into subscriber buffer
    const current = await repo.get("wf-1");
    await repo.save({ ...current!, version: 3 }, [makeEvent("wf-1")]);

    // Collect the remaining 2 events (cursor 2 from replay, cursor 3 from buffer)
    const rest: WorkflowEvent[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await iter.next();
      if (!r.done) rest.push(r.value);
    }

    expect(rest).toHaveLength(2);
    expect(rest[0]?.cursor).toBe(2);
    expect(rest[1]?.cursor).toBe(3);

    await iter.return?.();
  });

  it("dedup at replay/live seam: events saved before first next() are not re-yielded from buffer", async () => {
    const repo = new InMemoryWorkflowRepository();
    const workflow = await seedWorkflow(repo);

    const iter = repo.subscribe("wf-1", 0)[Symbol.asyncIterator]();

    // Save BEFORE first next(): events land in both persisted store AND subscriber buffer.
    // Without the cursor <= lastYielded guard, replay yields them and the live drain re-yields them.
    await repo.save({ ...workflow, version: 2 }, [makeEvent("wf-1"), makeEvent("wf-1")]);

    const r1 = await iter.next();
    const r2 = await iter.next();
    expect(r1.value?.cursor).toBe(1);
    expect(r2.value?.cursor).toBe(2);

    const current = await repo.get("wf-1");
    const livePromise = iter.next();
    await Promise.resolve();
    await repo.save({ ...current!, version: 3 }, [makeEvent("wf-1")]);

    const r3 = await livePromise;
    expect(r3.value?.cursor).toBe(3);

    await iter.return?.();
  });

  it("abort cleanup: breaking removes subscriber from internal set", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedWorkflow(repo);

    expect(repo.subscriberCount("wf-1")).toBe(0);

    const iter = repo.subscribe("wf-1", 0)[Symbol.asyncIterator]();
    expect(repo.subscriberCount("wf-1")).toBe(1);

    // Break the iteration
    await iter.return?.();

    // Subscriber should be removed
    expect(repo.subscriberCount("wf-1")).toBe(0);
  });

  it("mark-ready command produces events that arrive via subscribe", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedWorkflow(repo);

    const iterable = repo.subscribe("wf-1", 0);
    const collectPromise = collectN(iterable, 1);

    await Promise.resolve();
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId, now },
    });

    const events = await collectPromise;
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.workflowId).toBe("wf-1");
    expect(events[0]?.kind).toBe("task-transitioned");
    expect(events[0]?.cursor).toBe(1);
    if (events[0]?.kind === "task-transitioned") {
      expect(events[0].payload.taskId).toBe(taskId);
      expect(events[0].payload.toExecutionStatus).toBe("ready");
    }
  });
});
