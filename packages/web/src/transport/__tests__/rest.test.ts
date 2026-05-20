import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Connection } from "../../connections/store.js";
import type { Workflow, WorkflowSpec } from "@minions/engine";

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
  repoId: "fixture-repo",
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

    it("sends the stored bearer token", async () => {
      FETCH_MOCK.mockResolvedValueOnce(jsonResponse([]));

      const { listWorkflows } = await import("../rest.js");
      await listWorkflows(CONN);

      const [, init] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Headers;
      expect(headers.get("Authorization")).toBe("Bearer tok");
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
        repoId: "fixture-repo",
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

  describe("push helpers", () => {
    it("GETs /push/vapid-public-key", async () => {
      FETCH_MOCK.mockResolvedValueOnce(jsonResponse({ publicKey: "vapid" }));

      const { getVapidPublicKey } = await import("../rest.js");
      const result = await getVapidPublicKey(CONN);

      const [url] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://engine-test/push/vapid-public-key");
      expect(result.publicKey).toBe("vapid");
    });

    it("POSTs /push/subscribe with workflowId and nested subscription", async () => {
      FETCH_MOCK.mockResolvedValueOnce(jsonResponse({ ok: true }, 201));

      const { subscribePush } = await import("../rest.js");
      await subscribePush(CONN, {
        workflowId: "wf-1",
        subscription: {
          endpoint: "https://push.example/sub",
          keys: { p256dh: "p256dh", auth: "auth" },
        },
      });

      const [url, init] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://engine-test/push/subscribe");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        workflowId: "wf-1",
        subscription: {
          endpoint: "https://push.example/sub",
          keys: { p256dh: "p256dh", auth: "auth" },
        },
      });
    });

    it("GETs /workflows/:id/push-subscriptions", async () => {
      FETCH_MOCK.mockResolvedValueOnce(jsonResponse({
        subscriptions: [{ endpoint: "https://push.example/sub" }],
      }));

      const { listPushSubscriptions } = await import("../rest.js");
      const result = await listPushSubscriptions(CONN, "wf-1");

      const [url, init] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://engine-test/workflows/wf-1/push-subscriptions");
      expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
      expect(result).toEqual({
        subscriptions: [{ endpoint: "https://push.example/sub" }],
      });
    });

    it("DELETEs /push/subscribe with endpoint and workflowId", async () => {
      FETCH_MOCK.mockResolvedValueOnce(jsonResponse({ ok: true }));

      const { unsubscribePush } = await import("../rest.js");
      await unsubscribePush(CONN, "https://push.example/sub", "wf-1");

      const [url, init] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://engine-test/push/subscribe");
      expect(init.method).toBe("DELETE");
      expect(JSON.parse(init.body as string)).toEqual({
        endpoint: "https://push.example/sub",
        workflowId: "wf-1",
      });
    });
  });

  describe("deleteWorkflow", () => {
    it("DELETEs /workflows/:id and resolves on 204", async () => {
      FETCH_MOCK.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const { deleteWorkflow } = await import("../rest.js");
      await expect(deleteWorkflow(CONN, "wf-1")).resolves.toBeUndefined();

      const [url, init] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://engine-test/workflows/wf-1");
      expect((init as RequestInit).method).toBe("DELETE");
    });

    it("throws ApiError on 404", async () => {
      FETCH_MOCK.mockResolvedValueOnce(
        jsonResponse({ code: "not_found", message: "workflow not found", details: {} }, 404),
      );

      const { deleteWorkflow, ApiError } = await import("../rest.js");
      await expect(deleteWorkflow(CONN, "missing")).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe("audit helpers", () => {
    it("GETs /audit/events with beforeTs and beforeId cursor params", async () => {
      FETCH_MOCK.mockResolvedValueOnce(jsonResponse({ events: [] }));

      const { getAuditEvents } = await import("../rest.js");
      await getAuditEvents(CONN, {
        limit: 50,
        beforeTs: "2026-05-03T00:00:00.000Z",
        beforeId: "ev-2",
        action: "alert",
        workflowId: "wf-1",
      });

      const [url] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        "http://engine-test/audit/events?limit=50&beforeTs=2026-05-03T00%3A00%3A00.000Z&beforeId=ev-2&action=alert&workflowId=wf-1",
      );
    });

    it("GETs /audit/workflows/:id with beforeTs and beforeId cursor params", async () => {
      FETCH_MOCK.mockResolvedValueOnce(jsonResponse({ events: [] }));

      const { getWorkflowAuditEvents } = await import("../rest.js");
      await getWorkflowAuditEvents(CONN, "wf-1", {
        limit: 25,
        beforeTs: "2026-05-03T00:00:00.000Z",
        beforeId: "ev-9",
      });

      const [url] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        "http://engine-test/audit/workflows/wf-1?limit=25&beforeTs=2026-05-03T00%3A00%3A00.000Z&beforeId=ev-9",
      );
    });

    it("GETs /alerts with beforeTs and beforeId cursor params", async () => {
      FETCH_MOCK.mockResolvedValueOnce(jsonResponse({ alerts: [] }));

      const { getAlerts } = await import("../rest.js");
      await getAlerts(CONN, {
        limit: 10,
        beforeTs: "2026-05-03T00:00:00.000Z",
        beforeId: "al-4",
      });

      const [url] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        "http://engine-test/alerts?limit=10&beforeTs=2026-05-03T00%3A00%3A00.000Z&beforeId=al-4",
      );
    });
  });

  describe("listTranscript", () => {
    it("GETs /workflows/:id/runs/:runId/transcript and returns transcript array", async () => {
      const fixture = {
        transcript: [
          { seq: 1, occurredAt: "2026-01-01T00:00:00Z", providerEvent: { kind: "assistant_text", text: "hi" } },
          { seq: 2, occurredAt: "2026-01-01T00:00:01Z", providerEvent: { kind: "thinking", text: "hmm" } },
        ],
      };
      FETCH_MOCK.mockResolvedValueOnce(jsonResponse(fixture));

      const { listTranscript } = await import("../rest.js");
      const result = await listTranscript(CONN, "wf-1", "run-1");

      const [url] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://engine-test/workflows/wf-1/runs/run-1/transcript");
      expect(result.transcript).toHaveLength(2);
      expect(result.transcript[0]?.seq).toBe(1);
      expect(result.transcript[1]?.providerEvent.kind).toBe("thinking");
    });

    it("throws ApiError on 404 (workflow not found)", async () => {
      FETCH_MOCK.mockResolvedValueOnce(
        jsonResponse({ code: "not_found", message: "workflow not found", details: {} }, 404),
      );

      const { listTranscript, ApiError } = await import("../rest.js");
      await expect(listTranscript(CONN, "missing", "run-1")).rejects.toBeInstanceOf(ApiError);
    });
  });
});
