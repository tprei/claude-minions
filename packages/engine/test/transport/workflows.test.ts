import { describe, expect, it, vi } from "vitest";
import { NoopRestackExecutor } from "../../src/application/restack-executor.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createRecoveryService } from "../../src/application/recovery-service.js";
import { silentLogger } from "../test-helpers.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { createServer } from "../../src/transport/server.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";
import type { WorkflowPlannerService } from "../../src/application/planner-service.js";

const now = "2026-05-04T11:19:00.000Z";

function makeApp(knownRepoIds?: string[]) {
  const repo = new InMemoryWorkflowRepository();
  const executor = new NoopRestackExecutor();
  const runtime = new StubRuntimeBackend();
  const recoveryService = createRecoveryService(repo, executor, runtime, () => now, silentLogger());
  const app = createServer({
    repo,
    recoveryService,
    executor,
    ...(knownRepoIds !== undefined ? { isKnownRepoId: (repoId: string) => knownRepoIds.includes(repoId) } : {}),
  });
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
        kind: "single-task", repoId: "fixture-repo", tasks: [{ id: "t1", title: "Task", prompt: "Do something" }],
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
      body: JSON.stringify({ id: "wf-1", kind: "single-task", repoId: "fixture-repo", tasks: [] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("invalid_request");
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

  it("returns 400 when repoId is not configured", async () => {
    const { app } = makeApp(["known-repo"]);

    const res = await app.request("/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "wf-1",
        kind: "single-task",
        repoId: "missing-repo",
        tasks: [{ id: "t1", title: "Task", prompt: "Do something" }],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; details: { field: string; expected: string } };
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("repoId");
    expect(body.details.expected).toBe("configured repo id");
  });
});

describe("POST /workflows/plan", () => {
  it("rejects unknown repoId before invoking the planner", async () => {
    const repo = new InMemoryWorkflowRepository();
    const executor = new NoopRestackExecutor();
    const runtime = new StubRuntimeBackend();
    const recoveryService = createRecoveryService(repo, executor, runtime, () => now, silentLogger());
    const plannerService = { plan: vi.fn() } as unknown as WorkflowPlannerService;
    const app = createServer({
      repo,
      recoveryService,
      executor,
      plannerService,
      isKnownRepoId: (repoId) => repoId === "known-repo",
    });

    const res = await app.request("/workflows/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "ship it", repoId: "missing-repo" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; details: { field: string } };
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("repoId");
    expect(plannerService.plan).not.toHaveBeenCalled();
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

describe("GET /workflows/:id/runs/:runId/transcript", () => {
  it("returns 404 when workflow does not exist", async () => {
    const { app } = makeApp();
    const res = await app.request("/workflows/nonexistent/runs/run-1/transcript");
    expect(res.status).toBe(404);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 200 with empty transcript for existing workflow with no entries", async () => {
    const { app, repo } = makeApp();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, []);

    const res = await app.request("/workflows/wf-1/runs/run-1/transcript");
    expect(res.status).toBe(200);
    const body = await res.json() as { transcript: unknown[] };
    expect(body.transcript).toEqual([]);
  });

  it("returns 200 with persisted transcript entries in order", async () => {
    const { app, repo } = makeApp();
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(workflow, []);

    await repo.appendTranscript("wf-1", "run-1", now, { kind: "assistant_text", text: "hello" });
    await repo.appendTranscript("wf-1", "run-1", now, { kind: "thinking", text: "reasoning" });

    const res = await app.request("/workflows/wf-1/runs/run-1/transcript");
    expect(res.status).toBe(200);
    const body = await res.json() as { transcript: Array<{ seq: number; providerEvent: { kind: string } }> };
    expect(body.transcript).toHaveLength(2);
    expect(body.transcript[0]?.seq).toBe(1);
    expect(body.transcript[0]?.providerEvent.kind).toBe("assistant_text");
    expect(body.transcript[1]?.seq).toBe(2);
    expect(body.transcript[1]?.providerEvent.kind).toBe("thinking");
  });
});
