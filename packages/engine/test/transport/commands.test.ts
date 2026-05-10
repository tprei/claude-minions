import { describe, expect, it, vi } from "vitest";
import { NoopRestackExecutor } from "../../src/application/restack-executor.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createRecoveryService } from "../../src/application/recovery-service.js";
import { silentLogger } from "../test-helpers.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { createServer } from "../../src/transport/server.js";
import type { ContinueTaskService } from "../../src/application/continue-task-service.js";
import type { RetryTaskService } from "../../src/application/retry-task-service.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";
import type { WorkflowEvent } from "../../src/domain/events.js";

const now = "2026-05-04T11:19:00.000Z";

function makeApp(opts: { continueTaskService?: ContinueTaskService; retryTaskService?: RetryTaskService } = {}) {
  const repo = new InMemoryWorkflowRepository();
  const executor = new NoopRestackExecutor();
  const runtime = new StubRuntimeBackend();
  const recoveryService = createRecoveryService(repo, executor, runtime, () => now, silentLogger());
  const app = createServer({ repo, recoveryService, executor, ...opts });
  return { app, repo };
}

async function seedWorkflow(repo: InMemoryWorkflowRepository) {
  const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
  await repo.save(workflow, []);
  return workflow;
}

describe("POST /commands", () => {
  it("transition-task happy path: mark-ready returns 200 with workflow and events", async () => {
    const { app, repo } = makeApp();
    await seedWorkflow(repo);

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "transition-task",
        workflowId: "wf-1",
        transition: { kind: "mark-ready", taskId: "wf-1:task", now },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { workflow: { graph: Record<string, { executionStatus: string }>; version: number }; events: WorkflowEvent[] };
    expect(body.workflow.version).toBe(2);
    expect(body.workflow.graph["wf-1:task"]?.executionStatus).toBe("ready");

    const transitionEvent = body.events.find(
      (e): e is Extract<WorkflowEvent, { kind: "task-transitioned" }> => e.kind === "task-transitioned",
    );
    expect(transitionEvent).toBeDefined();
    expect(transitionEvent!.payload.taskId).toBe("wf-1:task");
    expect(transitionEvent!.payload.fromExecutionStatus).toBe("pending");
    expect(transitionEvent!.payload.toExecutionStatus).toBe("ready");
    expect(transitionEvent!.payload.transitionKind).toBe("mark-ready");
  });

  it("returns 404 when workflow does not exist", async () => {
    const { app } = makeApp();

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "transition-task",
        workflowId: "missing",
        transition: { kind: "mark-ready", taskId: "t", now },
      }),
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 400 on invalid_transition (task already ready)", async () => {
    const { app, repo } = makeApp();
    await seedWorkflow(repo);

    // First mark-ready succeeds
    await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "transition-task",
        workflowId: "wf-1",
        transition: { kind: "mark-ready", taskId: "wf-1:task", now },
      }),
    });

    // Second mark-ready on same task triggers invalid_transition
    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "transition-task",
        workflowId: "wf-1",
        transition: { kind: "mark-ready", taskId: "wf-1:task", now },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("invalid_transition");
  });

  it("returns 400 on unknown command kind", async () => {
    const { app } = makeApp();

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "totally-unknown" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("invalid_kind");
  });

  it("unexpected internal error returns sanitized 500 internal_error (no leaked message)", async () => {
    const { app, repo } = makeApp();
    await seedWorkflow(repo);

    vi.spyOn(repo, "save").mockRejectedValueOnce(new Error("disk caught fire — secret path /var/lib"));

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "transition-task",
        workflowId: "wf-1",
        transition: { kind: "mark-ready", taskId: "wf-1:task", now },
      }),
    });

    expect(res.status).toBe(500);
    const body = await res.json() as { code: string; message: string };
    expect(body.code).toBe("internal_error");
    expect(body.message).toBe("internal server error");
    expect(body.message).not.toContain("disk caught fire");
  });

  it("returns 400 (not 500) when valid kind is sent with malformed payload", async () => {
    const { app, repo } = makeApp();
    await seedWorkflow(repo);

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "request-restack", workflowId: "wf-1" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("invalid_request");
  });

  it("returns 400 on malformed JSON body", async () => {
    const { app } = makeApp();

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("invalid_body");
  });

  it("continue-task routes to continueTaskService stub", async () => {
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    const serviceStub = {
      run: vi.fn().mockResolvedValue({ workflow, events: [] }),
    } as unknown as ContinueTaskService;

    const { app, repo } = makeApp({ continueTaskService: serviceStub });
    await repo.save(workflow, []);

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "continue-task",
        workflowId: "wf-1",
        taskId: "wf-1:task",
        prompt: "please continue",
        now,
      }),
    });

    expect(res.status).toBe(200);
    expect(serviceStub.run).toHaveBeenCalledOnce();
    expect(serviceStub.run).toHaveBeenCalledWith({
      workflowId: "wf-1",
      taskId: "wf-1:task",
      prompt: "please continue",
    });
  });

  it("continue-task without service returns 500", async () => {
    const { app, repo } = makeApp();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, []);

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "continue-task",
        workflowId: "wf-1",
        taskId: "wf-1:task",
        prompt: "please continue",
        now,
      }),
    });

    expect(res.status).toBe(500);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("internal_error");
  });

  it("retry-task routes to retryTaskService stub", async () => {
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    const serviceStub = {
      run: vi.fn().mockResolvedValue({ workflow, events: [] }),
    } as unknown as RetryTaskService;

    const { app, repo } = makeApp({ retryTaskService: serviceStub });
    await repo.save(workflow, []);

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "retry-task",
        workflowId: "wf-1",
        taskId: "wf-1:task",
        prompt: "start fresh",
        now,
      }),
    });

    expect(res.status).toBe(200);
    expect(serviceStub.run).toHaveBeenCalledOnce();
    expect(serviceStub.run).toHaveBeenCalledWith({
      workflowId: "wf-1",
      taskId: "wf-1:task",
      prompt: "start fresh",
    });
  });

  it("retry-task without service returns 500", async () => {
    const { app, repo } = makeApp();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, []);

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "retry-task",
        workflowId: "wf-1",
        taskId: "wf-1:task",
        prompt: "start fresh",
        now,
      }),
    });

    expect(res.status).toBe(500);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("internal_error");
  });

  it("returns 409 on version_conflict when expectedVersion does not match", async () => {
    const { app, repo } = makeApp();
    await seedWorkflow(repo);

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "transition-task",
        workflowId: "wf-1",
        transition: { kind: "mark-ready", taskId: "wf-1:task", expectedVersion: 99, now },
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("version_conflict");
  });

  it("request-restack idempotency: same key twice returns empty events on second call", async () => {
    const { app, repo } = makeApp();
    await seedWorkflow(repo);

    const command = {
      kind: "request-restack",
      workflowId: "wf-1",
      input: { operationId: "op-1", ancestorId: "wf-1:task", idempotencyKey: "k1", now },
    };

    const res1 = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as { events: WorkflowEvent[] };

    const opEvent = body1.events.find(
      (e): e is Extract<WorkflowEvent, { kind: "graph-operation-changed" }> => e.kind === "graph-operation-changed",
    );
    expect(opEvent).toBeDefined();
    expect(opEvent!.payload.operationId).toBe("op-1");
    expect(opEvent!.payload.kind).toBe("restack");
    expect(opEvent!.payload.fromStatus).toBeNull();
    expect(opEvent!.payload.toStatus).toBe("pending");

    const res2 = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...command, input: { ...command.input, operationId: "op-2" } }),
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as { events: unknown[] };
    expect(body2.events).toHaveLength(0);
  });
});
