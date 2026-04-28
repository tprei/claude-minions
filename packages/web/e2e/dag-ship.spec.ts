import { test, expect, type APIRequestContext } from "@playwright/test";
import { API_BASE, API_TOKEN } from "./utils.js";

interface SessionResponse {
  slug: string;
  title: string;
  mode: string;
  status: string;
  shipStage?: string;
  dagId?: string;
}

interface AuditEvent {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  target?: { kind: string; id: string };
  detail?: Record<string, unknown>;
}

interface ListEnvelope<T> {
  items: T[];
  nextCursor?: string;
}

const AUTH_HEADERS = {
  Authorization: `Bearer ${API_TOKEN}`,
  "Content-Type": "application/json",
};

async function createShipSession(
  api: APIRequestContext,
  prompt: string,
): Promise<SessionResponse> {
  const res = await api.post(`${API_BASE}/api/sessions`, {
    headers: AUTH_HEADERS,
    data: { mode: "ship", prompt },
  });
  expect(res.status(), `POST /api/sessions: ${await res.text()}`).toBe(201);
  return (await res.json()) as SessionResponse;
}

async function getSession(
  api: APIRequestContext,
  slug: string,
): Promise<SessionResponse> {
  const res = await api.get(`${API_BASE}/api/sessions/${slug}`, {
    headers: AUTH_HEADERS,
  });
  expect(res.ok(), `GET /api/sessions/${slug}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as SessionResponse;
}

async function postCommand(
  api: APIRequestContext,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await api.post(`${API_BASE}/api/commands`, {
    headers: AUTH_HEADERS,
    data: body,
  });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

async function listAudit(
  api: APIRequestContext,
  limit = 200,
): Promise<AuditEvent[]> {
  const res = await api.get(`${API_BASE}/api/audit/events?limit=${limit}`, {
    headers: AUTH_HEADERS,
  });
  expect(res.ok()).toBeTruthy();
  const env = (await res.json()) as ListEnvelope<AuditEvent>;
  return env.items;
}

test.describe("ship sessions + DAG operator surface", () => {
  test("ship session reaches stage=think after ship-advance", async ({ request }) => {
    const session = await createShipSession(request, "ship think e2e");
    expect(session.mode).toBe("ship");

    const advance = await postCommand(request, {
      kind: "ship-advance",
      sessionSlug: session.slug,
      toStage: "think",
    });
    expect(advance.status, JSON.stringify(advance.body)).toBe(200);

    await expect
      .poll(async () => (await getSession(request, session.slug)).shipStage, {
        timeout: 15_000,
        intervals: [250, 500, 1000],
      })
      .toBe("think");
  });

  test("session.create audit row is recorded for ship sessions", async ({ request }) => {
    const session = await createShipSession(request, "ship audit e2e");

    await expect
      .poll(
        async () => {
          const events = await listAudit(request);
          return events.find(
            (e) =>
              e.action === "session.create" &&
              e.target?.kind === "session" &&
              e.target.id === session.slug,
          );
        },
        { timeout: 15_000, intervals: [250, 500, 1000] },
      )
      .toBeDefined();
  });

  test("invalid ship-advance toStage is rejected with 400", async ({ request }) => {
    const session = await createShipSession(request, "ship invalid stage e2e");
    const result = await postCommand(request, {
      kind: "ship-advance",
      sessionSlug: session.slug,
      toStage: "not-a-real-stage",
    });
    expect(result.status).toBe(400);
  });

  test("GET /api/dags returns a list envelope", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/dags`, { headers: AUTH_HEADERS });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as ListEnvelope<unknown> | unknown[];
    const items = Array.isArray(body) ? body : body.items;
    expect(Array.isArray(items)).toBe(true);
  });

  test.skip("DAG can be retried via POST /api/commands {kind:'dag.retry'}", async () => {
    // BLOCKED: no `dag.retry` command exists in @minions/shared command.ts and
    // packages/engine/src/http/routes/commands.ts does not dispatch one. Adding
    // this requires (a) a new Command variant, (b) a DagRepo method to reset
    // failed/landed nodes back to `pending`, (c) an audit.record call. Re-enable
    // once the operator command is implemented.
  });

  test.skip("DAG cancel command sets nodes to cancelled", async () => {
    // BLOCKED: no `dag.cancel` command and DAGNodeStatus has no "cancelled"
    // variant (the closest existing terminal status is "skipped"). Re-enable
    // alongside the shared+engine work that introduces cancellation semantics.
  });

  test.skip("ship session shows verify-summary status when DAG is bound + landed", async () => {
    // BLOCKED: the mock provider does not naturally emit a fenced ```dag JSON
    // block, so parseDagFromTranscript() never fires and the ship coordinator
    // never advances think → plan → dag → verify. Driving this end-to-end
    // requires either (a) a fixture provider that emits a deterministic DAG
    // block, or (b) a test-only HTTP backdoor to inject a transcript event.
    // T27 already covers the verify-summary emission in unit tests; this
    // e2e is gated on a richer fixture provider.
  });

  test.skip("boot reconcile preserves ship stage across engine restart", async () => {
    // BLOCKED: playwright's `webServer` lifecycle starts the engine once per
    // run and does not expose a kill/restart hook from inside a test. T14's
    // boot reconcile is covered by engine unit tests
    // (packages/engine/src/ship/index.ts + sessions/registry.ts). Wiring an
    // e2e equivalent requires spawning the engine from a child_process inside
    // the test instead of relying on playwright.config.ts → webServer.
  });
});
