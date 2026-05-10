import { describe, expect, it } from "vitest";
import { NoopRestackExecutor } from "../../src/application/restack-executor.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createRecoveryService } from "../../src/application/recovery-service.js";
import { silentLogger } from "../test-helpers.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { createServer } from "../../src/transport/server.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";

const now = "2026-05-04T11:19:00.000Z";

function makeApp() {
  const repo = new InMemoryWorkflowRepository();
  const executor = new NoopRestackExecutor();
  const runtime = new StubRuntimeBackend();
  const recoveryService = createRecoveryService(repo, executor, runtime, () => now, silentLogger());
  const app = createServer({ repo, recoveryService, executor });
  return { app, repo };
}

describe("POST /workflows", () => {
  it("creates a workflow and returns 201 with workflow JSON", async () => {
    const { app } = makeApp();

    const res = await app.request("/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "wf-1",
        kind: "single-task",
        tasks: [{ id: "t1", title: "Task", prompt: "Do something" }],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; status: string };
    expect(body.id).toBe("wf-1");
    expect(body.status).toBe("active");
  });

  it("returns 400 on invalid spec (empty tasks array)", async () => {
    const { app } = makeApp();

    const res = await app.request("/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "wf-1", kind: "single-task", tasks: [] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("invalid_workflow");
  });

  it("returns 400 on malformed JSON body", async () => {
    const { app } = makeApp();

    const res = await app.request("/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("invalid_body");
  });
});

describe("GET /workflows", () => {
  it("returns empty array when no workflows exist", async () => {
    const { app } = makeApp();
    const res = await app.request("/workflows");
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(body).toEqual([]);
  });

  it("returns only active workflows by default", async () => {
    const { app, repo } = makeApp();
    const wf1 = createSingleTaskWorkflow("wf-1", { title: "T1", prompt: "P1" }, () => now);
    const wf2 = createSingleTaskWorkflow("wf-2", { title: "T2", prompt: "P2" }, () => now);
    await repo.save(wf1, []);
    await repo.save(wf2, []);
    const completed = { ...wf2, version: 2, status: "completed" as const };
    await repo.save(completed, []);

    const res = await app.request("/workflows");
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string }[];
    expect(body.map((w) => w.id)).toEqual(["wf-1"]);
  });

  it("returns all workflows with ?include=completed", async () => {
    const { app, repo } = makeApp();
    const wf1 = createSingleTaskWorkflow("wf-1", { title: "T1", prompt: "P1" }, () => now);
    const wf2 = createSingleTaskWorkflow("wf-2", { title: "T2", prompt: "P2" }, () => now);
    await repo.save(wf1, []);
    await repo.save(wf2, []);
    const completed = { ...wf2, version: 2, status: "completed" as const };
    await repo.save(completed, []);

    const res = await app.request("/workflows?include=completed");
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string }[];
    expect(body.map((w) => w.id).sort()).toEqual(["wf-1", "wf-2"]);
  });

  it("returns workflows ordered by updatedAt DESC", async () => {
    const { app, repo } = makeApp();
    const wf1 = createSingleTaskWorkflow("wf-1", { title: "T1", prompt: "P1" }, () => "2026-01-01T00:00:00.000Z");
    const wf2 = createSingleTaskWorkflow("wf-2", { title: "T2", prompt: "P2" }, () => "2026-01-03T00:00:00.000Z");
    const wf3 = createSingleTaskWorkflow("wf-3", { title: "T3", prompt: "P3" }, () => "2026-01-02T00:00:00.000Z");
    await repo.save(wf1, []);
    await repo.save(wf2, []);
    await repo.save(wf3, []);

    const res = await app.request("/workflows");
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string }[];
    expect(body.map((w) => w.id)).toEqual(["wf-2", "wf-3", "wf-1"]);
  });
});

describe("GET /workflows/:id", () => {
  it("returns the workflow snapshot", async () => {
    const { app, repo } = makeApp();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, []);

    const res = await app.request("/workflows/wf-1");

    expect(res.status).toBe(200);
    const body = await res.json() as { id: string };
    expect(body.id).toBe("wf-1");
  });

  it("returns 404 for unknown workflow id", async () => {
    const { app } = makeApp();

    const res = await app.request("/workflows/nonexistent");

    expect(res.status).toBe(404);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("not_found");
  });
});
