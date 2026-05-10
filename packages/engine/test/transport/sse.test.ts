import { describe, expect, it } from "vitest";
import { applyCommand } from "../../src/application/commands.js";
import { NoopRestackExecutor } from "../../src/application/restack-executor.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createRecoveryService } from "../../src/application/recovery-service.js";
import { silentLogger } from "../test-helpers.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { createServer } from "../../src/transport/server.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";
import type { WorkflowEvent } from "../../src/domain/events.js";

const now = "2026-05-04T11:19:00.000Z";
const taskId = "wf-1:task";

function makeApp() {
  const repo = new InMemoryWorkflowRepository();
  const executor = new NoopRestackExecutor();
  const runtime = new StubRuntimeBackend();
  const recoveryService = createRecoveryService(repo, executor, runtime, () => now, silentLogger());
  const app = createServer({ repo, recoveryService, executor });
  return { app, repo };
}

async function seedWorkflow(repo: InMemoryWorkflowRepository) {
  const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
  await repo.save(workflow, []);
  return workflow;
}

interface SSEFrame {
  event?: string;
  data?: string;
  id?: string;
}

async function* readSSE(response: Response): AsyncIterable<SSEFrame> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const parsed: SSEFrame = {};
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) parsed.event = line.slice(6).trim();
          else if (line.startsWith("data:")) parsed.data = line.slice(5).trim();
          else if (line.startsWith("id:")) parsed.id = line.slice(3).trim();
        }
        yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function collectSSEFrames(response: Response, n: number): Promise<SSEFrame[]> {
  const frames: SSEFrame[] = [];
  for await (const frame of readSSE(response)) {
    frames.push(frame);
    if (frames.length >= n) break;
  }
  return frames;
}

describe("GET /workflows/:id/events (SSE)", () => {
  it("returns 404 for unknown workflow", async () => {
    const { app } = makeApp();

    const res = await app.request("/workflows/nonexistent/events?since=0");
    expect(res.status).toBe(404);
  });

  it("replay: streams persisted events as SSE frames", async () => {
    const { app, repo } = makeApp();
    await seedWorkflow(repo);

    // Produce 2 events via a transition
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId, now },
    });

    const eventCount = (await repo.eventsSince("wf-1", 0)).length;
    expect(eventCount).toBeGreaterThanOrEqual(1);

    const res = await app.request("/workflows/wf-1/events?since=0");
    expect(res.status).toBe(200);

    const frames = await collectSSEFrames(res, eventCount);
    expect(frames.length).toBe(eventCount);
    expect(frames[0]?.id).toBe("1");
    expect(frames[0]?.event).toBe("task-transitioned");

    const parsed = JSON.parse(frames[0]!.data!) as WorkflowEvent;
    expect(parsed.kind).toBe("task-transitioned");
    expect(parsed.cursor).toBe(1);
    expect(parsed.workflowId).toBe("wf-1");
    if (parsed.kind === "task-transitioned") {
      expect(parsed.payload.taskId).toBe("wf-1:task");
    }
  });

  it("Last-Event-ID overrides since parameter", async () => {
    const { app, repo } = makeApp();
    const workflow = await seedWorkflow(repo);

    // Create 5 events
    await repo.save({ ...workflow, version: 2 }, [
      { cursor: 0, workflowId: "wf-1", kind: "workflow-status-changed", occurredAt: now,
        payload: { fromStatus: "active", toStatus: "active" } },
      { cursor: 0, workflowId: "wf-1", kind: "workflow-status-changed", occurredAt: now,
        payload: { fromStatus: "active", toStatus: "active" } },
      { cursor: 0, workflowId: "wf-1", kind: "workflow-status-changed", occurredAt: now,
        payload: { fromStatus: "active", toStatus: "active" } },
      { cursor: 0, workflowId: "wf-1", kind: "workflow-status-changed", occurredAt: now,
        payload: { fromStatus: "active", toStatus: "active" } },
      { cursor: 0, workflowId: "wf-1", kind: "workflow-status-changed", occurredAt: now,
        payload: { fromStatus: "active", toStatus: "active" } },
    ]);

    const res = await app.request("/workflows/wf-1/events?since=0", {
      headers: { "Last-Event-ID": "3" },
    });
    expect(res.status).toBe(200);

    // Should only get events with cursor > 3 (i.e., 4 and 5)
    const frames = await collectSSEFrames(res, 2);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.id).toBe("4");
    expect(frames[1]?.id).toBe("5");

    for (const frame of frames) {
      const parsed = JSON.parse(frame.data!) as WorkflowEvent;
      expect(parsed.kind).toBe("workflow-status-changed");
      expect(parsed.cursor).toBe(Number(frame.id));
      expect(parsed.workflowId).toBe("wf-1");
    }
  });

  it("provider-event frame has no id field; surrounding durable frames have id", async () => {
    const { app, repo } = makeApp();
    await seedWorkflow(repo);

    // Seed one durable event at cursor 1
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId, now },
    });

    const res = await app.request("/workflows/wf-1/events?since=0");
    expect(res.status).toBe(200);

    // Read the first durable frame (cursor 1)
    const frames1 = await collectSSEFrames(res, 1);
    expect(frames1[0]?.id).toBeDefined();

    // Now publish a transient frame via hub — need repo direct access
    const transient: WorkflowEvent = {
      cursor: 0,
      workflowId: "wf-1",
      kind: "provider-event",
      occurredAt: now,
      payload: {
        taskId,
        runId: "run-1",
        providerEvent: { kind: "assistant_text", text: "hello" },
      },
    };

    // Open a new SSE connection from cursor 0 to get replay + transient
    const res2 = await app.request("/workflows/wf-1/events?since=0");
    expect(res2.status).toBe(200);

    // Publish transient after stream opens
    const transientPromise = collectSSEFrames(res2, 2);
    repo.publishTransient("wf-1", transient);

    const frames2 = await transientPromise;
    // First frame is durable (cursor 1), second is transient (no id)
    const durableFrame = frames2.find((f) => f.event !== "provider-event" && f.id !== undefined) ?? frames2[0];
    const transientFrame = frames2.find((f) => f.event === "provider-event");

    expect(durableFrame?.id).toBeDefined();
    expect(transientFrame).toBeDefined();
    expect(transientFrame?.id).toBeUndefined();
  });

  it("live: applyCommand events arrive via SSE after stream opens", async () => {
    const { app, repo } = makeApp();
    await seedWorkflow(repo);

    // Open SSE on an empty workflow (no persisted events)
    const res = await app.request("/workflows/wf-1/events?since=0");
    expect(res.status).toBe(200);

    // In parallel, produce an event
    const eventPromise = applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId, now },
    });

    // Read the first SSE frame and verify it arrives
    const framePromise = collectSSEFrames(res, 1);
    await eventPromise;
    const frames = await framePromise;

    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0]?.event).toBe("task-transitioned");
    expect(frames[0]?.id).toBeDefined();

    const parsed = JSON.parse(frames[0]!.data!) as WorkflowEvent;
    if (parsed.kind === "task-transitioned") {
      expect(parsed.payload.toExecutionStatus).toBe("ready");
      expect(parsed.payload.taskId).toBe("wf-1:task");
    }
  });
});
