import { describe, expect, it } from "vitest";
import { NoopRestackExecutor } from "../../src/application/restack-executor.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createRecoveryService } from "../../src/application/recovery-service.js";
import { silentLogger } from "../test-helpers.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { createServer } from "../../src/transport/server.js";

const now = "2026-05-04T11:19:00.000Z";

function makeApp() {
  const repo = new InMemoryWorkflowRepository();
  const executor = new NoopRestackExecutor();
  const runtime = new StubRuntimeBackend();
  const recoveryService = createRecoveryService(repo, executor, runtime, () => now, silentLogger());
  const app = createServer({ repo, recoveryService, executor });
  return { app, repo };
}

async function postCommand(app: ReturnType<typeof makeApp>["app"], body: unknown) {
  return app.request("/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postWorkflow(app: ReturnType<typeof makeApp>["app"], body: unknown) {
  return app.request("/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("request shape validation", () => {
  it("transition-task missing transition.taskId returns 400 invalid_request", async () => {
    const { app } = makeApp();

    const res = await postCommand(app, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", now },
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; message: string; details: { field: string; expected: string } };
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("transition.taskId");
    expect(body.details.expected).toBe("string");
  });

  it("request-restack missing input.idempotencyKey returns 400 invalid_request", async () => {
    const { app } = makeApp();

    const res = await postCommand(app, {
      kind: "request-restack",
      workflowId: "wf-1",
      input: { operationId: "op-1", ancestorId: "task-1", now },
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; details: { field: string; expected: string } };
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("input.idempotencyKey");
    expect(body.details.expected).toBe("string");
  });

  it("start-restack missing now returns 400 invalid_request", async () => {
    const { app } = makeApp();

    const res = await postCommand(app, {
      kind: "start-restack",
      workflowId: "wf-1",
      operationId: "op-1",
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; details: { field: string } };
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("now");
  });

  it("mark-restack-conflict with error not a string returns 400 invalid_request with field error", async () => {
    const { app } = makeApp();

    const res = await postCommand(app, {
      kind: "mark-restack-conflict",
      workflowId: "wf-1",
      operationId: "op-1",
      error: 42,
      now,
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; details: { field: string; expected: string } };
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("error");
    expect(body.details.expected).toBe("string");
  });

  it("complete-restack missing input.operationId returns 400 invalid_request", async () => {
    const { app } = makeApp();

    const res = await postCommand(app, {
      kind: "complete-restack",
      workflowId: "wf-1",
      input: { now },
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; details: { field: string; expected: string } };
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("input.operationId");
    expect(body.details.expected).toBe("string");
  });

  it("POST /workflows missing tasks returns 400 invalid_request with field tasks", async () => {
    const { app } = makeApp();

    const res = await postWorkflow(app, { id: "wf-1", kind: "single-task" });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; details: { field: string; expected: string } };
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("tasks");
    expect(body.details.expected).toBe("array");
  });

  it("POST /workflows with empty tasks array passes validator and fails with invalid_workflow from domain", async () => {
    const { app } = makeApp();

    const res = await postWorkflow(app, { id: "wf-1", kind: "single-task", tasks: [] });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("invalid_workflow");
  });

  it("retry-task with missing prompt returns 400 invalid_request", async () => {
    const { app } = makeApp();

    const res = await postCommand(app, {
      kind: "retry-task",
      workflowId: "wf-1",
      taskId: "task-1",
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; details: { field: string; expected: string } };
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("prompt");
    expect(body.details.expected).toBe("non-empty string");
  });

  it("retry-task with empty prompt returns 400 invalid_request", async () => {
    const { app } = makeApp();

    const res = await postCommand(app, {
      kind: "retry-task",
      workflowId: "wf-1",
      taskId: "task-1",
      prompt: "   ",
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; details: { field: string; expected: string } };
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("prompt");
    expect(body.details.expected).toBe("non-empty string");
  });

  it("continue-task with missing taskId returns 400 invalid_request", async () => {
    const { app } = makeApp();

    const res = await postCommand(app, {
      kind: "continue-task",
      workflowId: "wf-1",
      prompt: "continue please",
      now,
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; details: { field: string; expected: string } };
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("taskId");
  });

  it("continue-task with empty prompt returns 400 invalid_request", async () => {
    const { app } = makeApp();

    const res = await postCommand(app, {
      kind: "continue-task",
      workflowId: "wf-1",
      taskId: "task-1",
      prompt: "   ",
      now,
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; details: { field: string; expected: string } };
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("prompt");
    expect(body.details.expected).toBe("non-empty string");
  });

  it("POST /workflows with valid policy.autoLand:true accepted", async () => {
    const { app } = makeApp();

    const res = await postWorkflow(app, {
      id: "wf-1",
      kind: "single-task",
      tasks: [{ id: "t1", title: "T", prompt: "P" }],
      policy: { autoLand: true },
    });

    expect(res.status).toBe(201);
  });

  it("POST /workflows with valid policy.autoMergeOnGreen:true accepted", async () => {
    const { app } = makeApp();

    const res = await postWorkflow(app, {
      id: "wf-1",
      kind: "single-task",
      tasks: [{ id: "t1", title: "T", prompt: "P" }],
      policy: { autoMergeOnGreen: true },
    });

    expect(res.status).toBe(201);
  });

  it("POST /workflows with invalid policy.autoLand (string) rejected", async () => {
    const { app } = makeApp();

    const res = await postWorkflow(app, {
      id: "wf-1",
      kind: "single-task",
      tasks: [{ id: "t1", title: "T", prompt: "P" }],
      policy: { autoLand: "yes" },
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; details: { field: string } };
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("policy.autoLand");
  });

  it("POST /workflows with invalid policy.autoMergeOnGreen (number) rejected", async () => {
    const { app } = makeApp();

    const res = await postWorkflow(app, {
      id: "wf-1",
      kind: "single-task",
      tasks: [{ id: "t1", title: "T", prompt: "P" }],
      policy: { autoMergeOnGreen: 1 },
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; details: { field: string } };
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("policy.autoMergeOnGreen");
  });

  it("POST /workflows with policy:{} accepted (all defaults)", async () => {
    const { app } = makeApp();

    const res = await postWorkflow(app, {
      id: "wf-1",
      kind: "single-task",
      tasks: [{ id: "t1", title: "T", prompt: "P" }],
      policy: {},
    });

    expect(res.status).toBe(201);
  });
});
