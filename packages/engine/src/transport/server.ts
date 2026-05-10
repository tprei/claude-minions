import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { applyCommand } from "../application/commands.js";
import type { Command, CommandKind } from "../application/commands.js";
import type { CIBabysitterService } from "../application/ci-babysitter-service.js";
import type { QualityGateService } from "../application/quality-gate-service.js";
import type { CompletionDispatcher } from "../application/completion-dispatcher.js";
import type { ContinueTaskService } from "../application/continue-task-service.js";
import type { MergeService } from "../application/merge-service.js";
import { MergeServiceError } from "../application/merge-service.js";
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

export interface ServerDeps {
  repo: WorkflowRepository;
  recoveryService: RecoveryService;
  executor: RestackExecutor;
  continueTaskService?: ContinueTaskService;
  retryTaskService?: RetryTaskService;
  mergeService?: MergeService;
  ciBabysitter?: CIBabysitterService;
  qualityGateService?: QualityGateService;
  completionDispatcher?: CompletionDispatcher;
  pushService?: PushService;
  subscriptions?: SubscriptionRepository;
  vapidPublicKey?: string;
  pwaRoot?: string;
  observability?: ObservabilityService;
  log?: Logger;
  supervisor?: SupervisorWithRepos;
}

type AcceptedCommandKind = CommandKind | "continue-task" | "retry-task";

const VALID_COMMAND_KINDS = new Set<AcceptedCommandKind>([
  "transition-task",
  "request-restack",
  "start-restack",
  "complete-restack",
  "mark-restack-conflict",
  "continue-task",
  "retry-task",
]);

export function createServer(deps: ServerDeps): Hono {
  const app = new Hono();
  const { repo } = deps;

  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      return c.newResponse(null, 204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
      });
    }
    await next();
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID");
  });

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

    const workflow = createWorkflow(body as WorkflowSpec);
    await repo.save(workflow, []);
    deps.pushService?.attach(workflow.id);
    deps.ciBabysitter?.attach(workflow.id);
    deps.qualityGateService?.attach(workflow.id);
    deps.completionDispatcher?.attach(workflow.id);
    deps.observability?.attach(workflow.id);
    return c.json(workflow, 201);
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

  app.post("/commands", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ code: "invalid_body", message: "request body is not valid JSON" }, 400);
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
    return c.json({ ok: true });
  });

  app.get("/workflows/:id/events", async (c) => {
    const workflowId = c.req.param("id");

    const workflow = await repo.get(workflowId);
    if (!workflow) {
      return c.json({ code: "not_found", message: "workflow not found", details: {} }, 404);
    }

    const sinceParam = c.req.query("since");
    let fromCursor = sinceParam !== undefined ? parseInt(sinceParam, 10) : 0;
    if (isNaN(fromCursor)) fromCursor = 0;

    const lastEventId = c.req.header("last-event-id");
    if (lastEventId !== undefined) {
      const parsed = parseInt(lastEventId, 10);
      if (!isNaN(parsed)) fromCursor = parsed;
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
          if (event.kind === "provider-event" || event.kind === "merge-phase") {
            // omit id: so browser EventSource doesn't advance Last-Event-ID past the durable cursor
            await stream.writeSSE({ event: event.kind, data: JSON.stringify(event) });
          } else {
            await stream.writeSSE({ event: event.kind, data: JSON.stringify(event), id: String(event.cursor) });
          }
        }
      } finally {
        await iterator.return?.();
      }
    });
  });

  app.get("/audit/events", (c) => {
    if (!deps.supervisor) {
      return c.json({ code: "supervisor_disabled", message: "supervisor not configured" }, 503);
    }
    const limitParam = c.req.query("limit");
    const limit = limitParam !== undefined ? Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 500) : 100;
    const beforeTs = c.req.query("beforeTs");
    const action = c.req.query("action");
    const workflowId = c.req.query("workflowId");
    const events = deps.supervisor.auditRepo.list({
      limit,
      ...(beforeTs !== undefined ? { beforeTs } : {}),
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
    const limitParam = c.req.query("limit");
    const limit = limitParam !== undefined ? Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 500) : 100;
    const beforeTs = c.req.query("beforeTs");
    const events = deps.supervisor.auditRepo.listByWorkflow(workflowId, {
      limit,
      ...(beforeTs !== undefined ? { beforeTs } : {}),
    });
    return c.json({ events });
  });

  app.get("/alerts", (c) => {
    if (!deps.supervisor) {
      return c.json({ code: "supervisor_disabled", message: "supervisor not configured" }, 503);
    }
    const limitParam = c.req.query("limit");
    const limit = limitParam !== undefined ? Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 500) : 100;
    const beforeTs = c.req.query("beforeTs");
    const alerts = deps.supervisor.alertRepo.list({
      limit,
      ...(beforeTs !== undefined ? { beforeTs } : {}),
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
