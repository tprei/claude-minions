import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/application/commands.js";
import { InMemoryWorkflowRepository } from "../src/application/repository.js";
import { createSingleTaskWorkflow } from "../src/domain/workflow.js";

const now = "2026-05-04T11:19:00.000Z";

async function seedWorkflow(repo: InMemoryWorkflowRepository) {
  const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
  await repo.save(workflow, []);
  return workflow;
}

describe("applyCommand happy paths", () => {
  it("transition-task persists, returns events, bumps workflow version", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedWorkflow(repo);

    const result = await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now },
    });

    expect(result.workflow.version).toBe(2);
    expect(result.events.length).toBeGreaterThan(0);
    const saved = await repo.get("wf-1");
    expect(saved?.version).toBe(2);
  });

  it("request-restack creates an operation and returns events", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedWorkflow(repo);

    const result = await applyCommand(repo, {
      kind: "request-restack",
      workflowId: "wf-1",
      input: { operationId: "op-1", ancestorId: "wf-1:task", idempotencyKey: "k1", now },
    });

    expect(result.workflow.operations["op-1"]).toBeDefined();
    expect(result.events.some((e) => e.kind === "graph-operation-changed")).toBe(true);
  });

  it("request-restack writes idempotency row atomically with save", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedWorkflow(repo);

    await applyCommand(repo, {
      kind: "request-restack",
      workflowId: "wf-1",
      input: { operationId: "op-1", ancestorId: "wf-1:task", idempotencyKey: "k1", now },
    });

    const ref = await repo.lookupIdempotency("wf-1", "k1");
    expect(ref).toBe("op-1");
  });

  it("start-restack transitions operation to running", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedWorkflow(repo);
    await applyCommand(repo, {
      kind: "request-restack",
      workflowId: "wf-1",
      input: { operationId: "op-1", ancestorId: "wf-1:task", idempotencyKey: "k1", now },
    });

    const result = await applyCommand(repo, {
      kind: "start-restack",
      workflowId: "wf-1",
      operationId: "op-1",
      now,
    });

    expect(result.workflow.operations["op-1"]?.status).toBe("running");
  });

  it("complete-restack transitions operation to completed", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedWorkflow(repo);
    await applyCommand(repo, {
      kind: "request-restack",
      workflowId: "wf-1",
      input: { operationId: "op-1", ancestorId: "wf-1:task", idempotencyKey: "k1", now },
    });
    await applyCommand(repo, {
      kind: "start-restack",
      workflowId: "wf-1",
      operationId: "op-1",
      now,
    });

    const result = await applyCommand(repo, {
      kind: "complete-restack",
      workflowId: "wf-1",
      input: { operationId: "op-1", now },
    });

    expect(result.workflow.operations["op-1"]?.status).toBe("completed");
  });

  it("mark-restack-conflict transitions operation to conflict", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedWorkflow(repo);
    await applyCommand(repo, {
      kind: "request-restack",
      workflowId: "wf-1",
      input: { operationId: "op-1", ancestorId: "wf-1:task", idempotencyKey: "k1", now },
    });
    await applyCommand(repo, {
      kind: "start-restack",
      workflowId: "wf-1",
      operationId: "op-1",
      now,
    });

    const result = await applyCommand(repo, {
      kind: "mark-restack-conflict",
      workflowId: "wf-1",
      operationId: "op-1",
      error: "merge conflict",
      now,
    });

    expect(result.workflow.operations["op-1"]?.status).toBe("conflict");
  });

  it("recoveryIdempotency option writes row atomically with save", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedWorkflow(repo);

    await applyCommand(
      repo,
      {
        kind: "transition-task",
        workflowId: "wf-1",
        transition: { kind: "mark-ready", taskId: "wf-1:task", now },
      },
      { recoveryIdempotency: { key: "recovery-key-1", resultRef: "recovery:recover-task:wf-1:task" } },
    );

    const ref = await repo.lookupIdempotency("wf-1", "recovery-key-1");
    expect(ref).toBe("recovery:recover-task:wf-1:task");
  });
});

describe("applyCommand error cases", () => {
  it("throws not_found for unknown workflow", async () => {
    const repo = new InMemoryWorkflowRepository();

    await expect(
      applyCommand(repo, {
        kind: "transition-task",
        workflowId: "missing",
        transition: { kind: "mark-ready", taskId: "t", now },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects a save built from a stale snapshot with version_conflict", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedWorkflow(repo);

    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now },
    });
    const advanced = await repo.get("wf-1");
    expect(advanced?.version).toBe(2);

    await expect(
      repo.save({ ...advanced!, version: 2 }, []),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });
});

describe("applyCommand idempotency", () => {
  it("request-restack twice with same idempotencyKey returns same operation id and empty events on second call", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedWorkflow(repo);

    const first = await applyCommand(repo, {
      kind: "request-restack",
      workflowId: "wf-1",
      input: { operationId: "op-1", ancestorId: "wf-1:task", idempotencyKey: "k1", now },
    });

    const second = await applyCommand(repo, {
      kind: "request-restack",
      workflowId: "wf-1",
      input: { operationId: "op-2", ancestorId: "wf-1:task", idempotencyKey: "k1", now },
    });

    expect(first.workflow.operations["op-1"]).toBeDefined();
    expect(second.events).toHaveLength(0);
    expect(second.workflow.operations["op-1"]).toBeDefined();
    expect(second.workflow.operations["op-2"]).toBeUndefined();
  });
});
