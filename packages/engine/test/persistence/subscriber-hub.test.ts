import { describe, expect, it } from "vitest";
import { SubscriberHub } from "../../src/persistence/subscriber-hub.js";
import type { WorkflowEvent } from "../../src/domain/events.js";

const now = "2026-05-04T11:19:00.000Z";

function makeEvent(workflowId: string, cursor: number): WorkflowEvent {
  return {
    cursor,
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

function makeTransientEvent(workflowId: string): Extract<WorkflowEvent, { kind: "provider-event" }> {
  return {
    cursor: 0,
    workflowId,
    kind: "provider-event",
    occurredAt: now,
    payload: {
      taskId: "t",
      runId: "run-1",
      providerEvent: { kind: "assistant_text", text: "hello" },
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

describe("SubscriberHub", () => {
  it("multiple subscribers each receive notified events independently", async () => {
    const hub = new SubscriberHub();
    const stored: WorkflowEvent[] = [];

    const replay = async () => [...stored];

    const sub1 = hub.subscribe("wf-1", 0, replay);
    const sub2 = hub.subscribe("wf-1", 0, replay);

    const p1 = collectN(sub1, 1);
    const p2 = collectN(sub2, 1);

    await Promise.resolve();
    const event = makeEvent("wf-1", 1);
    stored.push(event);
    hub.notify("wf-1", [event]);

    const [events1, events2] = await Promise.all([p1, p2]);
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
    expect(events1[0]?.cursor).toBe(1);
    expect(events2[0]?.cursor).toBe(1);
  });

  it("abort cleanup: return() removes subscriber from internal count", async () => {
    const hub = new SubscriberHub();
    const replay = async () => [] as WorkflowEvent[];

    expect(hub.subscriberCount("wf-1")).toBe(0);

    const iter = hub.subscribe("wf-1", 0, replay)[Symbol.asyncIterator]();
    expect(hub.subscriberCount("wf-1")).toBe(1);

    await iter.return?.();
    expect(hub.subscriberCount("wf-1")).toBe(0);
  });

  it("notifyTransient reaches a live subscriber", async () => {
    const hub = new SubscriberHub();
    const replay = async () => [] as WorkflowEvent[];

    const sub = hub.subscribe("wf-1", 0, replay);
    const p = collectN(sub, 1);

    await Promise.resolve();
    const transient = makeTransientEvent("wf-1");
    hub.notifyTransient("wf-1", transient);

    const events = await p;
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("provider-event");
  });

  it("notifyTransient: transient frame yielded without advancing lastYielded; durable events still gate by cursor", async () => {
    const hub = new SubscriberHub();
    const stored: WorkflowEvent[] = [];
    const replay = async () => [...stored];

    const iter = hub.subscribe("wf-1", 0, replay)[Symbol.asyncIterator]();

    const transient = makeTransientEvent("wf-1");
    hub.notifyTransient("wf-1", transient);

    const r1 = await iter.next();
    expect(r1.value?.kind).toBe("provider-event");

    // Durable event with cursor 1 should still be gated by lastYielded (still 0, not advanced by transient)
    const durable = makeEvent("wf-1", 1);
    stored.push(durable);
    hub.notify("wf-1", [durable]);

    const r2 = await iter.next();
    expect(r2.value?.kind).toBe("task-transitioned");
    expect(r2.value?.cursor).toBe(1);

    await iter.return?.();
  });

  it("notifyTransient: durable event with cursor <= lastYielded is still deduped after transient", async () => {
    const hub = new SubscriberHub();
    const stored: WorkflowEvent[] = [];
    const replay = async () => [...stored];

    const iter = hub.subscribe("wf-1", 0, replay)[Symbol.asyncIterator]();

    // First yield a durable event to advance lastYielded to 1
    const durable1 = makeEvent("wf-1", 1);
    stored.push(durable1);
    hub.notify("wf-1", [durable1]);
    const r1 = await iter.next();
    expect(r1.value?.cursor).toBe(1);

    // Now send a transient (cursor 0), should yield
    const transient = makeTransientEvent("wf-1");
    hub.notifyTransient("wf-1", transient);
    const r2 = await iter.next();
    expect(r2.value?.kind).toBe("provider-event");

    // A duplicate durable with cursor 1 should be deduped (lastYielded still 1)
    hub.notify("wf-1", [durable1]);
    // Send a new durable at cursor 2 to confirm stream is still live
    const durable2 = makeEvent("wf-1", 2);
    stored.push(durable2);
    hub.notify("wf-1", [durable2]);

    const r3 = await iter.next();
    expect(r3.value?.cursor).toBe(2);

    await iter.return?.();
  });

  it("notifyTransient before replay completes is buffered and yielded after replay", async () => {
    const hub = new SubscriberHub();
    let resolveReplay!: (events: WorkflowEvent[]) => void;
    const replayPromise = new Promise<WorkflowEvent[]>((r) => { resolveReplay = r; });
    const replay = () => replayPromise;

    const iter = hub.subscribe("wf-1", 0, replay)[Symbol.asyncIterator]();

    // Notify transient while replay is still pending
    const transient = makeTransientEvent("wf-1");
    hub.notifyTransient("wf-1", transient);

    // Unblock replay with no stored events
    resolveReplay([]);

    const r1 = await iter.next();
    expect(r1.value?.kind).toBe("provider-event");

    await iter.return?.();
  });

  it("dedup at replay/live seam: events buffered before first next() are not re-yielded", async () => {
    const hub = new SubscriberHub();
    const stored: WorkflowEvent[] = [];

    const replay = async () => [...stored];

    const iter = hub.subscribe("wf-1", 0, replay)[Symbol.asyncIterator]();

    // Notify before first next() — goes into both stored (replay) AND subscriber buffer
    const e1 = makeEvent("wf-1", 1);
    const e2 = makeEvent("wf-1", 2);
    stored.push(e1, e2);
    hub.notify("wf-1", [e1, e2]);

    const r1 = await iter.next();
    const r2 = await iter.next();
    expect(r1.value?.cursor).toBe(1);
    expect(r2.value?.cursor).toBe(2);

    // Next live event should be 3, not a duplicate of 1 or 2
    const livePromise = iter.next();
    await Promise.resolve();
    const e3 = makeEvent("wf-1", 3);
    stored.push(e3);
    hub.notify("wf-1", [e3]);

    const r3 = await livePromise;
    expect(r3.value?.cursor).toBe(3);

    await iter.return?.();
  });
});
