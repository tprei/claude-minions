import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Connection } from "../../connections/store.js";
import type { Workflow, WorkflowSpec } from "@minions/engine-next";

const CONN: Connection = {
  id: "conn-test",
  label: "test",
  baseUrl: "http://engine-test",
  token: "tok",
  color: "#fff",
};

const WORKFLOW_FIXTURE: Workflow = {
  id: "wf-1",
  kind: "single-task",
  status: "active",
  graph: {
    "t-1": {
      id: "t-1",
      workflowId: "wf-1",
      title: "Do the thing",
      prompt: "please do it",
      dependsOn: [],
      executionStatus: "pending",
      stackStatus: "clean",
      priority: 0,
      claims: [],
      contract: { summary: "Do the thing", expectedArtifacts: [] },
      artifacts: [],
      runs: [],
      readiness: "unknown",
      version: 1,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  },
  operations: {},
  policy: { maxConcurrent: 3, autoLand: false, autoMergeOnGreen: false },
  version: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const FETCH_MOCK = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();

describe("rest transport", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", FETCH_MOCK);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    FETCH_MOCK.mockReset();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  describe("listWorkflows", () => {
    it("GETs /workflows and returns a Workflow array", async () => {
      FETCH_MOCK.mockResolvedValueOnce(jsonResponse([WORKFLOW_FIXTURE]));

      const { listWorkflows } = await import("../rest.js");
      const result = await listWorkflows(CONN);

      expect(FETCH_MOCK).toHaveBeenCalledOnce();
      const [url] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://engine-test/workflows");
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe("wf-1");
      expect(result[0]?.status).toBe("active");
    });

    it("passes include=completed query param when option is set", async () => {
      FETCH_MOCK.mockResolvedValueOnce(jsonResponse([]));

      const { listWorkflows } = await import("../rest.js");
      await listWorkflows(CONN, { includeCompleted: true });

      const [url] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://engine-test/workflows?include=completed");
    });
  });

  describe("getWorkflow", () => {
    it("GETs /workflows/:id and returns a single Workflow", async () => {
      FETCH_MOCK.mockResolvedValueOnce(jsonResponse(WORKFLOW_FIXTURE));

      const { getWorkflow } = await import("../rest.js");
      const result = await getWorkflow(CONN, "wf-1");

      const [url] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://engine-test/workflows/wf-1");
      expect(result.id).toBe("wf-1");
      expect(result.kind).toBe("single-task");
    });

    it("throws ApiError on 404", async () => {
      FETCH_MOCK.mockResolvedValueOnce(
        jsonResponse({ code: "not_found", message: "workflow not found", details: {} }, 404),
      );

      const { getWorkflow, ApiError } = await import("../rest.js");
      await expect(getWorkflow(CONN, "missing")).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe("createWorkflow", () => {
    it("POSTs /workflows with the spec body", async () => {
      FETCH_MOCK.mockResolvedValueOnce(jsonResponse(WORKFLOW_FIXTURE, 201));

      const spec: WorkflowSpec = {
        id: "wf-1",
        kind: "single-task",
        tasks: [{ id: "t-1", title: "Do the thing", prompt: "please do it" }],
      };

      const { createWorkflow } = await import("../rest.js");
      const result = await createWorkflow(CONN, spec);

      const [url, init] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://engine-test/workflows");
      expect((init as RequestInit).method).toBe("POST");
      expect(result.id).toBe("wf-1");
    });
  });

  describe("dispatchCommand", () => {
    it("POSTs /commands with continue-task payload", async () => {
      FETCH_MOCK.mockResolvedValueOnce(jsonResponse({ ok: true }));

      const { dispatchCommand } = await import("../rest.js");
      await dispatchCommand(CONN, {
        kind: "continue-task",
        workflowId: "wf-1",
        taskId: "t-1",
        prompt: "continue please",
      });

      const [url, init] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://engine-test/commands");
      expect((init as RequestInit).method).toBe("POST");
      const body = JSON.parse((init as RequestInit).body as string) as { kind: string };
      expect(body.kind).toBe("continue-task");
    });
  });

  describe("mergeTask", () => {
    it("POSTs /workflows/:id/tasks/:taskId/merge", async () => {
      FETCH_MOCK.mockResolvedValueOnce(jsonResponse({ ok: true }));

      const { mergeTask } = await import("../rest.js");
      await mergeTask(CONN, "wf-1", "t-1");

      const [url, init] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://engine-test/workflows/wf-1/tasks/t-1/merge");
      expect((init as RequestInit).method).toBe("POST");
    });
  });
});
