import type { Connection } from "../connections/store.js";
import type {
  Workflow,
  WorkflowSpec,
  TranscriptEntry,
} from "@minions/engine";
import type { VersionInfo } from "@minions/shared";

export class ApiError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown> | undefined;
  readonly status: number;

  constructor(status: number, body: { code: string; message: string; details?: Record<string, unknown> }) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.detail = body.details;
    this.status = status;
  }
}

export async function apiFetch<T>(
  conn: Connection,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${conn.baseUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let body: { code: string; message: string; details?: Record<string, unknown> };
    try {
      body = await res.json() as typeof body;
    } catch {
      body = { code: "unknown", message: res.statusText };
    }
    throw new ApiError(res.status, body);
  }

  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

export interface ListWorkflowsOptions {
  includeCompleted?: boolean;
}

export function listWorkflows(
  conn: Connection,
  opts?: ListWorkflowsOptions,
): Promise<Workflow[]> {
  const qs = opts?.includeCompleted ? "?include=completed" : "";
  return apiFetch<Workflow[]>(conn, `/workflows${qs}`);
}

export function getVersion(conn: Connection): Promise<VersionInfo> {
  return apiFetch<VersionInfo>(conn, "/version");
}

export function getWorkflow(conn: Connection, id: string): Promise<Workflow> {
  return apiFetch<Workflow>(conn, `/workflows/${encodeURIComponent(id)}`);
}

export function createWorkflow(conn: Connection, spec: WorkflowSpec): Promise<Workflow> {
  return apiFetch<Workflow>(conn, "/workflows", {
    method: "POST",
    body: JSON.stringify(spec),
  });
}

export function deleteWorkflow(conn: Connection, id: string): Promise<void> {
  return apiFetch<void>(conn, `/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export interface ContinueTaskInput {
  kind: "continue-task";
  workflowId: string;
  taskId: string;
  prompt: string;
}

export interface RetryTaskInput {
  kind: "retry-task";
  workflowId: string;
  taskId: string;
  prompt: string;
}

export interface TransitionTaskInput {
  kind: "transition-task";
  workflowId: string;
  transition: {
    kind: string;
    taskId: string;
    now: string;
  };
}

export interface LandWorkflowInput {
  kind: "land-workflow";
  workflowId: string;
}

export type DispatchCommandInput =
  | ContinueTaskInput
  | RetryTaskInput
  | TransitionTaskInput
  | LandWorkflowInput;

export function dispatchCommand(
  conn: Connection,
  input: DispatchCommandInput,
): Promise<unknown> {
  return apiFetch<unknown>(conn, "/commands", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface MergeResult {
  ok: boolean;
  [key: string]: unknown;
}

export function mergeTask(
  conn: Connection,
  workflowId: string,
  taskId: string,
): Promise<MergeResult> {
  return apiFetch<MergeResult>(
    conn,
    `/workflows/${encodeURIComponent(workflowId)}/tasks/${encodeURIComponent(taskId)}/merge`,
    { method: "POST" },
  );
}

export function getVapidPublicKey(conn: Connection): Promise<{ publicKey: string }> {
  return apiFetch<{ publicKey: string }>(conn, "/push/vapid-public-key");
}

export interface PushSubscribeInput {
  workflowId: string;
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
}

export function subscribePush(conn: Connection, sub: PushSubscribeInput): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(conn, "/push/subscribe", {
    method: "POST",
    body: JSON.stringify(sub),
  });
}

export function unsubscribePush(
  conn: Connection,
  endpoint: string,
  workflowId: string,
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(conn, "/push/subscribe", {
    method: "DELETE",
    body: JSON.stringify({ endpoint, workflowId }),
  });
}

export interface AuditEventsOptions {
  limit?: number;
  beforeTs?: string;
  action?: string;
  workflowId?: string;
}

export function getAuditEvents(
  conn: Connection,
  opts?: AuditEventsOptions,
): Promise<{ events: unknown[] }> {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.beforeTs) params.set("beforeTs", opts.beforeTs);
  if (opts?.action) params.set("action", opts.action);
  if (opts?.workflowId) params.set("workflowId", opts.workflowId);
  const qs = params.toString();
  return apiFetch<{ events: unknown[] }>(conn, qs ? `/audit/events?${qs}` : "/audit/events");
}

export function getWorkflowAuditEvents(
  conn: Connection,
  workflowId: string,
  opts?: Pick<AuditEventsOptions, "limit" | "beforeTs">,
): Promise<{ events: unknown[] }> {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.beforeTs) params.set("beforeTs", opts.beforeTs);
  const qs = params.toString();
  return apiFetch<{ events: unknown[] }>(
    conn,
    qs
      ? `/audit/workflows/${encodeURIComponent(workflowId)}?${qs}`
      : `/audit/workflows/${encodeURIComponent(workflowId)}`,
  );
}

export { type TranscriptEntry };

export function listTranscript(
  conn: Connection,
  workflowId: string,
  runId: string,
): Promise<{ transcript: TranscriptEntry[] }> {
  return apiFetch<{ transcript: TranscriptEntry[] }>(
    conn,
    `/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/transcript`,
  );
}

export function planWorkflow(
  conn: Connection,
  prompt: string,
): Promise<{ spec: WorkflowSpec }> {
  return apiFetch<{ spec: WorkflowSpec }>(conn, "/workflows/plan", {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
}

export function getAlerts(
  conn: Connection,
  opts?: Pick<AuditEventsOptions, "limit" | "beforeTs">,
): Promise<{ alerts: unknown[] }> {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.beforeTs) params.set("beforeTs", opts.beforeTs);
  const qs = params.toString();
  return apiFetch<{ alerts: unknown[] }>(conn, qs ? `/alerts?${qs}` : "/alerts");
}
