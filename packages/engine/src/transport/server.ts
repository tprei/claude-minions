import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { timingSafeEqual } from "node:crypto";
import { applyCommand } from "../application/commands.js";
import type { Command, CommandKind } from "../application/commands.js";
import type { CIBabysitterService } from "../application/ci-babysitter-service.js";
import type { QualityGateService } from "../application/quality-gate-service.js";
import type { CompletionDispatcher } from "../application/completion-dispatcher.js";
import type { LocalFinalizeService } from "../application/local-finalize-service.js";
import type { ContinueTaskService } from "../application/continue-task-service.js";
import type { MergeService } from "../application/merge-service.js";
import { MergeServiceError } from "../application/merge-service.js";
import type { LandWorkflowService } from "../application/land-workflow-service.js";
import type { RetryTaskService } from "../application/retry-task-service.js";
import type { RecoveryService } from "../application/recovery-service.js";
import type { WorkflowRepository } from "../application/repository.js";
import type { RestackExecutor } from "../application/restack-executor.js";
import type { PushService } from "../application/push-service.js";
import type { SubscriptionRepository } from "../application/subscription-repository.js";
import { DomainError } from "../domain/errors.js";
import { createWorkflow } from "../domain/workflow.js";
import type { WorkflowSpec } from "../domain/types.js";
import { domainErrorToHttp } from "./errors.js";
import { validateCommand, validatePushSubscribe, validatePushUnsubscribe, validateWorkflowSpec, validateAlertSubscribe, validateAlertUnsubscribe } from "./validators.js";
import type { ObservabilityService } from "../observability/observability-service.js";
import type { Logger } from "../observability/logger.js";
import type { SupervisorWithRepos } from "../supervisor/supervisor.js";
import type { WorkflowPlannerService } from "../application/planner-service.js";
import type { SchedulerService } from "../application/scheduler-service.js";

type DoctorCheckStatus = "ok" | "degraded" | "error";

interface RuntimeDoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  detail?: string;
  checkedAt: string;
}

interface RuntimeDoctorReport {
  status: DoctorCheckStatus;
  checks: RuntimeDoctorCheck[];
  checkedAt: string;
}

interface RuntimeVersionInfo {
  apiVersion: string;
  libraryVersion: string;
  buildSha: string;
  features: string[];
  featuresPending: Array<{ flag: string; reason: string }>;
  provider: string;
  providers: string[];
  repos: Array<{ id: string; label: string; remote?: string; defaultBranch?: string }>;
  pluginSet: string[];
  startedAt: string;
}

export interface ServerDeps {
  repo: WorkflowRepository;
  recoveryService: RecoveryService;
  executor: RestackExecutor;
  continueTaskService?: ContinueTaskService;
  retryTaskService?: RetryTaskService;
  mergeService?: MergeService;
  landWorkflowService?: LandWorkflowService;
  ciBabysitter?: CIBabysitterService;
  qualityGateService?: QualityGateService;
  completionDispatcher?: CompletionDispatcher;
  localFinalizeService?: LocalFinalizeService;
  pushService?: PushService;
  subscriptions?: SubscriptionRepository;
  vapidPublicKey?: string;
  pwaRoot?: string;
  observability?: ObservabilityService;
  log?: Logger;
  supervisor?: SupervisorWithRepos;
  plannerService?: WorkflowPlannerService;
  schedulerService?: SchedulerService;
  versionInfo?: () => RuntimeVersionInfo;
  health?: () => Promise<Pick<RuntimeDoctorReport, "status" | "checkedAt">>;
  doctor?: () => Promise<RuntimeDoctorReport>;
  metrics?: () => Promise<string>;
  authToken?: string;
  corsOrigins?: string[];
  isKnownRepoId?: (repoId: string) => boolean;
}

type AcceptedCommandKind = CommandKind | "continue-task" | "retry-task" | "land-workflow";

const VALID_COMMAND_KINDS = new Set<AcceptedCommandKind>([
  "transition-task",
  "request-restack",
  "start-restack",
  "complete-restack",
  "mark-restack-conflict",
  "continue-task",
  "retry-task",
  "land-workflow",
]);

const CORS_METHODS = "GET, POST, DELETE, PATCH, OPTIONS";
const CORS_HEADERS = "Content-Type, Last-Event-ID, Authorization";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

interface HistoryListCursor {
  timestamp: string;
  id: string;
}

interface HistoryListQuery {
  limit: number;
  before?: HistoryListCursor;
}

type HistoryListQueryResult =
  | { ok: true; query: HistoryListQuery }
  | { ok: false; message: string; details: Record<string, unknown> };

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function isStaticPath(pathname: string): boolean {
  return pathname === "/" ||
    pathname === "/manifest.json" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/sw.js" ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/assets/");
}

function isPublicRoute(method: string, pathname: string): boolean {
  if (method === "OPTIONS") return true;
  if (method === "GET" && pathname === "/health") return true;
  if (method === "GET" && isStaticPath(pathname)) return true;
  return false;
}

function isWorkflowSse(pathname: string, method: string): boolean {
  return method === "GET" && /^\/workflows\/[^/]+\/events$/.test(pathname);
}

function isAuthorizedRequest(input: {
  token: string;
  header: string | undefined;
  queryToken: string | undefined;
  allowQueryToken: boolean;
}): boolean {
  const headerToken = bearerToken(input.header);
  if (headerToken !== undefined && safeEqual(headerToken, input.token)) return true;
  return input.allowQueryToken && input.queryToken !== undefined && safeEqual(input.queryToken, input.token);
}

function corsOrigin(origin: string | undefined, allowed: string[] | undefined): string | undefined {
  if (allowed === undefined || allowed.length === 0) return undefined;
  if (allowed.includes("*")) return "*";
  if (origin !== undefined && allowed.includes(origin)) return origin;
  return undefined;
}

function parseCursor(raw: string | undefined): { ok: true; value: number } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: 0 };
  if (!/^\d+$/.test(raw)) return { ok: false, message: "cursor must be a non-negative integer" };
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return { ok: false, message: "cursor must be a safe integer" };
  return { ok: true, value };
}

function parseLimit(raw: string | undefined): { ok: true; value: number } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: DEFAULT_LIMIT };
  if (!/^\d+$/.test(raw)) return { ok: false, message: "limit must be a positive integer" };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    return { ok: false, message: `limit must be between 1 and ${MAX_LIMIT}` };
  }
  return { ok: true, value };
}

function invalidQuery(message: string): { code: string; message: string; details: Record<string, unknown> } {
  return { code: "invalid_request", message, details: {} };
}

function invalidFieldQuery(field: string, expected: string): Extract<HistoryListQueryResult, { ok: false }> {
  return {
    ok: false,
    message: `field "${field}" must be ${expected}`,
    details: { field, expected },
  };
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function parseHistoryListQuery(
  limitParam: string | undefined,
  beforeTs: string | undefined,
  beforeId: string | undefined,
): HistoryListQueryResult {
  const parsedLimit = parseLimit(limitParam);
  if (!parsedLimit.ok) return { ok: false, message: parsedLimit.message, details: {} };

  if (beforeTs === undefined && beforeId === undefined) {
    return { ok: true, query: { limit: parsedLimit.value } };
  }
  if (beforeTs === undefined) {
    return invalidFieldQuery("beforeTs", "a canonical ISO timestamp when beforeId is set");
  }
  if (!isCanonicalIsoTimestamp(beforeTs)) {
    return invalidFieldQuery("beforeTs", "a canonical ISO timestamp");
  }
  if (beforeId === undefined || beforeId.trim().length === 0) {
    return invalidFieldQuery("beforeId", "a non-empty string when beforeTs is set");
  }
  return { ok: true, query: { limit: parsedLimit.value, before: { timestamp: beforeTs, id: beforeId } } };
}

function invalidHistoryQuery(result: Extract<HistoryListQueryResult, { ok: false }>): { code: string; message: string; details: Record<string, unknown> } {
  return { code: "invalid_request", message: result.message, details: result.details };
}

function unknownRepoId(repoId: string): { code: string; message: string; details: Record<string, unknown> } {
  return {
    code: "invalid_request",
    message: `unknown repoId: ${repoId}`,
    details: { field: "repoId", expected: "configured repo id" },
  };
}

function isKnownRepoId(deps: ServerDeps, repoId: string): boolean {
  return deps.isKnownRepoId === undefined || deps.isKnownRepoId(repoId);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createServer(deps: ServerDeps): Hono {
  const app = new Hono();
  const { repo } = deps;

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const allowOrigin = corsOrigin(origin, deps.corsOrigins);
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Methods": CORS_METHODS,
      "Access-Control-Allow-Headers": CORS_HEADERS,
    };
    if (allowOrigin !== undefined) {
      corsHeaders["Access-Control-Allow-Origin"] = allowOrigin;
      if (allowOrigin !== "*") corsHeaders["Vary"] = "Origin";
    }

    if (c.req.method === "OPTIONS") {
      return c.newResponse(null, 204, corsHeaders);
    }
    await next();
    for (const [key, value] of Object.entries(corsHeaders)) {
      c.header(key, value);
    }
  });

  if (deps.authToken !== undefined) {
    const authToken = deps.authToken;
    app.use("*", async (c, next) => {
      const url = new URL(c.req.url);
      if (isPublicRoute(c.req.method, url.pathname)) {
        await next();
        return;
      }
      const allowed = isAuthorizedRequest({
        token: authToken,
        header: c.req.header("authorization"),
        queryToken: c.req.query("token"),
        allowQueryToken: isWorkflowSse(url.pathname, c.req.method),
      });
      if (!allowed) {
        return c.json(
          { code: "unauthorized", message: "missing or invalid bearer token", details: {} },
          401,
          { "WWW-Authenticate": "Bearer" },
        );
      }
      await next();
    });
  }

  if (deps.log) {
    const reqLog = deps.log;
    app.use("*", async (c, next) => {
      const start = Date.now();
      await next();
      reqLog.info("http", {
        kind: "http-request",
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        durationMs: Date.now() - start,
      });
    });
  }

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      const mapped = domainErrorToHttp(err);
      return c.json(mapped.body, mapped.status as 400 | 404 | 409);
    }
    // Validators are the front line for client errors. Anything reaching here
    // is an unexpected server failure — surface as 500 without leaking details.
    return c.json(
      { code: "internal_error", message: "internal server error", details: {} },
      500,
    );
  });

  app.get("/health", async (c) => {
    if (deps.health) {
      const report = await deps.health();
      const status = report.status === "ok" ? 200 : 503;
      return c.json(report, status);
    }
    if (!deps.doctor) {
      return c.json({ status: "ok" });
    }
    const report = await deps.doctor();
    const status = report.status === "ok" ? 200 : 503;
    return c.json({ status: report.status, checkedAt: report.checkedAt }, status);
  });

  app.get("/health/deep", async (c) => {
    if (!deps.doctor) {
      return c.json({ status: "ok", checks: [], checkedAt: new Date().toISOString() });
    }
    const report = await deps.doctor();
    const status = report.status === "ok" ? 200 : 503;
    return c.json(report, status);
  });

  app.get("/version", (c) => {
    if (!deps.versionInfo) {
      return c.json({
        apiVersion: "workflow-v1",
        libraryVersion: "0.1.0",
        buildSha: "unknown",
        features: [],
        featuresPending: [],
        provider: "unknown",
        providers: [],
        repos: [],
        pluginSet: [],
        startedAt: new Date().toISOString(),
      });
    }
    return c.json(deps.versionInfo());
  });

  app.get("/metrics", async (c) => {
    if (!deps.metrics) {
      return c.text("# HELP minions_metrics_configured Runtime metrics configured\n# TYPE minions_metrics_configured gauge\nminions_metrics_configured 0\n", 200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      });
    }
    try {
      return c.text(await deps.metrics(), 200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      });
    } catch {
      return c.text("# HELP minions_metrics_error Metrics collection error\n# TYPE minions_metrics_error gauge\nminions_metrics_error 1\n", 500, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      });
    }
  });

  app.get("/doctor", async (c) => {
    if (!deps.doctor) {
      return c.json({ status: "ok", checks: [], checkedAt: new Date().toISOString() });
    }
    const report = await deps.doctor();
    const status = report.status === "ok" ? 200 : 503;
    return c.json(report, status);
  });

  app.post("/workflows", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_body", message: "request body is not valid JSON" }, 400);
    }

    const validation = validateWorkflowSpec(body);
    if (!validation.ok) {
      return c.json(
        {
          code: "invalid_request",
          message: validation.failure.message,
          details: { field: validation.failure.field, expected: validation.failure.expected },
        },
        400,
      );
    }

    if (!isKnownRepoId(deps, (body as WorkflowSpec).repoId)) {
      return c.json(unknownRepoId((body as WorkflowSpec).repoId), 400);
    }

    const workflow = createWorkflow(body as WorkflowSpec);
    await repo.save(workflow, []);
    deps.pushService?.attach(workflow.id);
    deps.ciBabysitter?.attach(workflow.id);
    deps.qualityGateService?.attach(workflow.id);
    deps.completionDispatcher?.attach(workflow.id);
    deps.localFinalizeService?.attach(workflow.id);
    deps.observability?.attach(workflow.id);
    deps.schedulerService?.attach(workflow.id);
    return c.json(workflow, 201);
  });

  app.post("/workflows/plan", async (c) => {
    if (!deps.plannerService) {
      return c.json({ code: "planner_not_configured", message: "planner service not configured" }, 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_body", message: "request body is not valid JSON" }, 400);
    }

    if (!isObjectRecord(body)) {
      return c.json({ code: "invalid_request", message: "request body must be an object" }, 400);
    }

    const prompt = body["prompt"];
    const repoId = body["repoId"];
    if (typeof prompt !== "string" || prompt.length === 0) {
      return c.json({ code: "invalid_request", message: 'field "prompt" is required and must be a non-empty string' }, 400);
    }
    if (typeof repoId !== "string" || repoId.length === 0) {
      return c.json({ code: "invalid_request", message: 'field "repoId" is required and must be a non-empty string' }, 400);
    }
    if (!isKnownRepoId(deps, repoId)) {
      return c.json(unknownRepoId(repoId), 400);
    }

    const spec = await deps.plannerService.plan({
      prompt,
      repoId,
    });
    return c.json({ spec });
  });

  app.get("/workflows", async (c) => {
    const includeCompleted = c.req.query("include") === "completed";
    const workflows = await deps.repo.list({ includeCompleted });
    return c.json(workflows);
  });

  app.get("/workflows/:id", async (c) => {
    const workflow = await repo.get(c.req.param("id"));
    if (!workflow) {
      return c.json({ code: "not_found", message: "workflow not found", details: {} }, 404);
    }
    return c.json(workflow);
  });

  app.delete("/workflows/:id", async (c) => {
    const workflowId = c.req.param("id");
    const workflow = await repo.get(workflowId);
    if (!workflow) {
      return c.json({ code: "not_found", message: "workflow not found", details: {} }, 404);
    }
    deps.pushService?.detach(workflowId);
    deps.ciBabysitter?.detach(workflowId);
    deps.qualityGateService?.detach(workflowId);
    deps.completionDispatcher?.detach(workflowId);
    deps.localFinalizeService?.detach(workflowId);
    deps.observability?.detach(workflowId);
    deps.schedulerService?.detach(workflowId);
    await deps.subscriptions?.removeByWorkflow(workflowId);
    await repo.delete(workflowId);
    return c.newResponse(null, 204);
  });

  app.post("/commands", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_body", message: "request body is not valid JSON" }, 400);
    }
    if (!isObjectRecord(body)) {
      return c.json({ code: "invalid_request", message: "request body must be an object" }, 400);
    }

    const kind = body["kind"];
    if (typeof kind !== "string" || !VALID_COMMAND_KINDS.has(kind as AcceptedCommandKind)) {
      return c.json({ code: "invalid_kind", message: `unknown command kind: ${String(kind)}` }, 400);
    }

    const validation = validateCommand(body);
    if (!validation.ok) {
      return c.json(
        {
          code: "invalid_request",
          message: validation.failure.message,
          details: { field: validation.failure.field, expected: validation.failure.expected },
        },
        400,
      );
    }

    if (kind === "continue-task") {
      if (!deps.continueTaskService) {
        return c.json({ code: "internal_error", message: "continue-task service not available", details: {} }, 500);
      }
      const result = await deps.continueTaskService.run({
        workflowId: body["workflowId"] as string,
        taskId: body["taskId"] as string,
        prompt: body["prompt"] as string,
      });
      return c.json(result);
    }

    if (kind === "retry-task") {
      if (!deps.retryTaskService) {
        return c.json({ code: "internal_error", message: "retry-task service not available", details: {} }, 500);
      }
      const result = await deps.retryTaskService.run({
        workflowId: body["workflowId"] as string,
        taskId: body["taskId"] as string,
        prompt: body["prompt"] as string,
      });
      return c.json(result);
    }

    if (kind === "land-workflow") {
      if (!deps.landWorkflowService) {
        return c.json({ code: "internal_error", message: "land-workflow service not available", details: {} }, 500);
      }
      try {
        const result = await deps.landWorkflowService.run({
          workflowId: body["workflowId"] as string,
        });
        return c.json(result);
      } catch (err) {
        if (err instanceof MergeServiceError && err.code === "merge_state_inconsistent") {
          return c.json(
            { code: "merge_state_inconsistent", message: "GitHub merged but internal state transition failed; operator must reconcile", details: err.details },
            500,
          );
        }
        throw err;
      }
    }

    const result = await applyCommand(repo, body as unknown as Command);
    return c.json(result);
  });

  app.post("/workflows/:id/tasks/:taskId/merge", async (c) => {
    if (!deps.mergeService) {
      return c.json({ code: "internal_error", message: "merge service not configured" }, 503);
    }
    const workflowId = c.req.param("id");
    const taskId = c.req.param("taskId");
    try {
      const result = await deps.mergeService.merge({ workflowId, taskId });
      return c.json(result);
    } catch (err) {
      if (err instanceof MergeServiceError && err.code === "merge_state_inconsistent") {
        return c.json(
          { code: "merge_state_inconsistent", message: "GitHub merged but internal state transition failed; operator must reconcile", details: { workflowId, taskId } },
          500,
        );
      }
      throw err;
    }
  });

  app.get("/push/vapid-public-key", (c) => {
    if (!deps.vapidPublicKey) {
      return c.json({ code: "push_disabled", message: "push notifications not configured" }, 503);
    }
    return c.json({ publicKey: deps.vapidPublicKey });
  });

  app.post("/push/subscribe", async (c) => {
    if (!deps.pushService || !deps.subscriptions) {
      return c.json({ code: "push_disabled", message: "push notifications not configured" }, 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_body", message: "request body is not valid JSON" }, 400);
    }

    const validation = validatePushSubscribe(body);
    if (!validation.ok) {
      return c.json(
        {
          code: "invalid_request",
          message: validation.failure.message,
          details: { field: validation.failure.field, expected: validation.failure.expected },
        },
        400,
      );
    }

    const b = body as Record<string, unknown>;
    const workflowId = b["workflowId"] as string;
    const workflow = await repo.get(workflowId);
    if (!workflow) {
      return c.json({ code: "not_found", message: "workflow not found", details: {} }, 404);
    }

    const sub = b["subscription"] as Record<string, unknown>;
    const keys = sub["keys"] as Record<string, string | undefined>;
    await deps.subscriptions.upsert({
      endpoint: sub["endpoint"] as string,
      workflowId,
      keys: { p256dh: keys["p256dh"] as string, auth: keys["auth"] as string },
    });
    deps.pushService.attach(workflowId);
    return c.json({ ok: true }, 201);
  });

  app.get("/workflows/:id/push-subscriptions", async (c) => {
    if (!deps.subscriptions) {
      return c.json({ code: "push_disabled", message: "push notifications not configured" }, 503);
    }

    const workflowId = c.req.param("id");
    const workflow = await repo.get(workflowId);
    if (!workflow) {
      return c.json({ code: "not_found", message: "workflow not found", details: {} }, 404);
    }

    const subscriptions = await deps.subscriptions.listByWorkflow(workflowId);
    return c.json({
      subscriptions: subscriptions.map(({ endpoint }) => ({ endpoint })),
    });
  });

  app.delete("/push/subscribe", async (c) => {
    if (!deps.subscriptions) {
      return c.json({ code: "push_disabled", message: "push notifications not configured" }, 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_body", message: "request body is not valid JSON" }, 400);
    }

    const validation = validatePushUnsubscribe(body);
    if (!validation.ok) {
      return c.json(
        {
          code: "invalid_request",
          message: validation.failure.message,
          details: { field: validation.failure.field, expected: validation.failure.expected },
        },
        400,
      );
    }

    const b = body as Record<string, unknown>;
    const endpoint = b["endpoint"] as string;
    const workflowId = b["workflowId"] as string;
    await deps.subscriptions.remove(endpoint, workflowId);
    const remaining = await deps.subscriptions.listByWorkflow(workflowId);
    if (remaining.length === 0) {
      deps.pushService?.detach(workflowId);
    }
    return c.json({ ok: true });
  });

  app.get("/workflows/:id/events", async (c) => {
    const workflowId = c.req.param("id");

    const workflow = await repo.get(workflowId);
    if (!workflow) {
      return c.json({ code: "not_found", message: "workflow not found", details: {} }, 404);
    }

    const lastEventId = c.req.header("last-event-id");
    let fromCursor = lastEventId === undefined && c.req.query("since") === undefined
      ? await repo.latestCursor(workflowId)
      : 0;

    const sinceParam = c.req.query("since");
    if (sinceParam !== undefined) {
      const since = parseCursor(sinceParam);
      if (!since.ok) return c.json(invalidQuery(since.message), 400);
      fromCursor = since.value;
    }

    if (lastEventId !== undefined) {
      const parsed = parseCursor(lastEventId);
      if (!parsed.ok) return c.json(invalidQuery(parsed.message), 400);
      fromCursor = parsed.value;
    }

    return streamSSE(c, async (stream) => {
      const iterable = repo.subscribe(workflowId, fromCursor);
      const iterator = iterable[Symbol.asyncIterator]();

      stream.onAbort(() => {
        void iterator.return?.();
      });

      try {
        while (true) {
          const result = await iterator.next();
          if (result.done) break;
          const event = result.value;
          await stream.writeSSE({ event: event.kind, data: JSON.stringify(event), id: String(event.cursor) });
        }
      } finally {
        await iterator.return?.();
      }
    });
  });

  app.get("/workflows/:id/runs/:runId/transcript", async (c) => {
    const workflowId = c.req.param("id");
    const runId = c.req.param("runId");
    const workflow = await repo.get(workflowId);
    if (!workflow) {
      return c.json({ code: "not_found", message: "workflow not found", details: {} }, 404);
    }
    const transcript = await repo.listTranscript(workflowId, runId);
    return c.json({ transcript });
  });

  app.get("/audit/events", (c) => {
    if (!deps.supervisor) {
      return c.json({ code: "supervisor_disabled", message: "supervisor not configured" }, 503);
    }
    const query = parseHistoryListQuery(c.req.query("limit"), c.req.query("beforeTs"), c.req.query("beforeId"));
    if (!query.ok) return c.json(invalidHistoryQuery(query), 400);
    const action = c.req.query("action");
    const workflowId = c.req.query("workflowId");
    const events = deps.supervisor.auditRepo.list({
      limit: query.query.limit,
      ...(query.query.before !== undefined ? { before: query.query.before } : {}),
      ...(action !== undefined ? { action } : {}),
      ...(workflowId !== undefined ? { workflowId } : {}),
    });
    return c.json({ events });
  });

  app.get("/audit/workflows/:id", (c) => {
    if (!deps.supervisor) {
      return c.json({ code: "supervisor_disabled", message: "supervisor not configured" }, 503);
    }
    const workflowId = c.req.param("id");
    const query = parseHistoryListQuery(c.req.query("limit"), c.req.query("beforeTs"), c.req.query("beforeId"));
    if (!query.ok) return c.json(invalidHistoryQuery(query), 400);
    const events = deps.supervisor.auditRepo.listByWorkflow(workflowId, {
      limit: query.query.limit,
      ...(query.query.before !== undefined ? { before: query.query.before } : {}),
    });
    return c.json({ events });
  });

  app.get("/alerts", (c) => {
    if (!deps.supervisor) {
      return c.json({ code: "supervisor_disabled", message: "supervisor not configured" }, 503);
    }
    const query = parseHistoryListQuery(c.req.query("limit"), c.req.query("beforeTs"), c.req.query("beforeId"));
    if (!query.ok) return c.json(invalidHistoryQuery(query), 400);
    const alerts = deps.supervisor.alertRepo.list({
      limit: query.query.limit,
      ...(query.query.before !== undefined ? { before: query.query.before } : {}),
    });
    return c.json({ alerts });
  });

  app.post("/alerts/subscribe", async (c) => {
    if (!deps.supervisor) {
      return c.json({ code: "supervisor_disabled", message: "supervisor not configured" }, 503);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_body", message: "request body is not valid JSON" }, 400);
    }
    const validation = validateAlertSubscribe(body);
    if (!validation.ok) {
      return c.json(
        {
          code: "invalid_request",
          message: validation.failure.message,
          details: { field: validation.failure.field, expected: validation.failure.expected },
        },
        400,
      );
    }
    const b = body as Record<string, unknown>;
    const sub = b["subscription"] as Record<string, unknown>;
    const keys = sub["keys"] as Record<string, string>;
    deps.supervisor.subRepo.upsert({
      endpoint: sub["endpoint"] as string,
      keys: { p256dh: keys["p256dh"] as string, auth: keys["auth"] as string },
    });
    return c.json({ ok: true }, 201);
  });

  app.delete("/alerts/subscribe", async (c) => {
    if (!deps.supervisor) {
      return c.json({ code: "supervisor_disabled", message: "supervisor not configured" }, 503);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_body", message: "request body is not valid JSON" }, 400);
    }
    const validation = validateAlertUnsubscribe(body);
    if (!validation.ok) {
      return c.json(
        {
          code: "invalid_request",
          message: validation.failure.message,
          details: { field: validation.failure.field, expected: validation.failure.expected },
        },
        400,
      );
    }
    const b = body as Record<string, unknown>;
    deps.supervisor.subRepo.remove(b["endpoint"] as string);
    return c.json({ ok: true });
  });

  if (deps.pwaRoot !== undefined) {
    app.use("/", async (c, next) => { await next(); c.header("Cache-Control", "no-cache"); });
    app.use("/sw.js", async (c, next) => { await next(); c.header("Cache-Control", "no-cache"); });
    app.get("/", serveStatic({ root: deps.pwaRoot, path: "index.html" }));
    app.get("/manifest.json", serveStatic({ root: deps.pwaRoot, path: "manifest.json" }));
    app.get("/sw.js", serveStatic({ root: deps.pwaRoot, path: "sw.js" }));
    app.get("/icons/*", serveStatic({ root: deps.pwaRoot }));
    app.get("/assets/*", serveStatic({ root: deps.pwaRoot }));
  }

  return app;
}
