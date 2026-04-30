import type { Connection } from "../connections/store.js";
import { dispatchCommand, type DispatchOptions } from "../store/optimistic.js";
import type {
  CleanupCandidatesResponse,
  CleanupPreviewRequest,
  CleanupPreviewResponse,
  CleanupExecuteRequest,
  CleanupExecuteResponse,
  CleanupableStatus,
} from "@minions/shared";
import type {
  Session,
  SessionStatus,
  SessionMode,
  CreateSessionRequest,
  CreateVariantsRequest,
  CreateVariantsResponse,
  TranscriptEvent,
  WorkspaceDiff,
  Screenshot,
  PullRequestPreview,
  MergeReadiness,
  Checkpoint,
  DAG,
  Command,
  CommandResult,
  Memory,
  MemoryKind,
  MemoryStatus,
  CreateMemoryRequest,
  MemoryReviewCommand,
  RuntimeConfigResponse,
  RuntimeOverrides,
  VapidPublicKeyResponse,
  PushSubscriptionInfo,
  GlobalStats,
  ModeStats,
  RecentStats,
  ReadinessSummary,
  AuditEvent,
  VersionInfo,
  ListEnvelope,
  OkEnvelope,
  Entrypoint,
  RegisterEntrypointRequest,
  LoopDefinition,
} from "../types.js";

export class ApiError extends Error {
  readonly error: string;
  readonly detail: Record<string, unknown> | undefined;
  readonly status: number;

  constructor(status: number, body: { error: string; message: string; detail?: Record<string, unknown> }) {
    super(body.message);
    this.name = "ApiError";
    this.error = body.error;
    this.detail = body.detail;
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
      "Authorization": `Bearer ${conn.token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let body: { error: string; message: string; detail?: Record<string, unknown> };
    try {
      body = await res.json() as typeof body;
    } catch {
      body = { error: "unknown", message: res.statusText };
    }
    throw new ApiError(res.status, body);
  }

  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

export interface GetSessionsOptions {
  status?: SessionStatus[];
  mode?: SessionMode[];
  repoId?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

export function getSessions(
  conn: Connection,
  opts?: GetSessionsOptions,
): Promise<ListEnvelope<Session>> {
  const params = new URLSearchParams();
  if (opts?.status && opts.status.length > 0) params.set("status", opts.status.join(","));
  if (opts?.mode && opts.mode.length > 0) params.set("mode", opts.mode.join(","));
  if (opts?.repoId) params.set("repoId", opts.repoId);
  if (opts?.q) params.set("q", opts.q);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.cursor) params.set("cursor", opts.cursor);
  const qs = params.toString();
  return apiFetch(conn, qs ? `/api/sessions?${qs}` : "/api/sessions");
}

export function getSession(conn: Connection, slug: string): Promise<Session> {
  return apiFetch(conn, `/api/sessions/${slug}`);
}

export function getTranscript(conn: Connection, slug: string): Promise<ListEnvelope<TranscriptEvent>> {
  return apiFetch(conn, `/api/sessions/${slug}/transcript`);
}

export function fetchTranscript(
  conn: Connection,
  slug: string,
  sinceSeq?: number,
): Promise<ListEnvelope<TranscriptEvent>> {
  const qs = sinceSeq === undefined ? "" : `?since=${sinceSeq}`;
  return apiFetch(conn, `/api/sessions/${slug}/transcript${qs}`);
}

export function getDiff(conn: Connection, slug: string): Promise<WorkspaceDiff> {
  return apiFetch(conn, `/api/sessions/${slug}/diff`);
}

export function getScreenshots(conn: Connection, slug: string): Promise<ListEnvelope<Screenshot>> {
  return apiFetch(conn, `/api/sessions/${slug}/screenshots`);
}

export function getPR(conn: Connection, slug: string): Promise<PullRequestPreview> {
  return apiFetch(conn, `/api/sessions/${slug}/pr`);
}

export function getReadiness(conn: Connection, slug: string): Promise<MergeReadiness> {
  return apiFetch(conn, `/api/sessions/${slug}/readiness`);
}

export function getCheckpoints(conn: Connection, slug: string): Promise<ListEnvelope<Checkpoint>> {
  return apiFetch(conn, `/api/sessions/${slug}/checkpoints`);
}

export function restoreCheckpoint(conn: Connection, slug: string, id: string): Promise<OkEnvelope> {
  return apiFetch(conn, `/api/sessions/${slug}/checkpoints/${id}/restore`, { method: "POST" });
}

export function getDags(conn: Connection): Promise<ListEnvelope<DAG>> {
  return apiFetch(conn, "/api/dags");
}

export function getDag(conn: Connection, id: string): Promise<DAG> {
  return apiFetch(conn, `/api/dags/${id}`);
}

export function retryDagNode(
  conn: Connection,
  dagId: string,
  nodeId: string,
): Promise<DAG> {
  return apiFetch(conn, `/api/dags/${dagId}/nodes/${nodeId}/retry`, {
    method: "POST",
  });
}

export function postCommand(conn: Connection, cmd: Command): Promise<CommandResult> {
  return apiFetch(conn, "/api/commands", { method: "POST", body: JSON.stringify(cmd) });
}

export type OptimisticCommandSpec = Pick<
  DispatchOptions<CommandResult>,
  "description" | "apply" | "rollback" | "awaitCommit"
>;

export function postCommandOptimistic(
  conn: Connection,
  cmd: Command,
  optimistic: OptimisticCommandSpec,
): Promise<CommandResult> {
  return dispatchCommand({
    connId: conn.id,
    description: optimistic.description,
    apply: optimistic.apply,
    rollback: optimistic.rollback,
    awaitCommit: optimistic.awaitCommit,
    request: () => postCommand(conn, cmd),
  });
}

export function postMessage(
  conn: Connection,
  payload: { sessionSlug?: string; prompt: string; [k: string]: unknown },
): Promise<CommandResult> {
  return apiFetch(conn, "/api/messages", { method: "POST", body: JSON.stringify(payload) });
}

export function createSession(conn: Connection, req: CreateSessionRequest): Promise<Session> {
  return apiFetch(conn, "/api/sessions", { method: "POST", body: JSON.stringify(req) });
}

export function deleteSession(conn: Connection, slug: string): Promise<OkEnvelope> {
  return apiFetch(conn, `/api/sessions/${slug}`, { method: "DELETE" });
}

export interface ListFilesOptions {
  q?: string;
  limit?: number;
}

export function listRepoFiles(
  conn: Connection,
  repoId: string,
  opts?: ListFilesOptions,
): Promise<{ items: string[] }> {
  const params = new URLSearchParams();
  if (opts?.q) params.set("q", opts.q);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const base = `/api/repos/${encodeURIComponent(repoId)}/files`;
  return apiFetch(conn, qs ? `${base}?${qs}` : base);
}

export interface ListMemoriesOptions {
  status?: MemoryStatus;
  kind?: MemoryKind;
  q?: string;
  repoId?: string;
}

export function listMemories(
  conn: Connection,
  opts?: ListMemoriesOptions,
): Promise<ListEnvelope<Memory>> {
  const params = new URLSearchParams();
  if (opts?.status) params.set("status", opts.status);
  if (opts?.kind) params.set("kind", opts.kind);
  if (opts?.q) params.set("q", opts.q);
  if (opts?.repoId) params.set("repoId", opts.repoId);
  const qs = params.toString();
  return apiFetch(conn, qs ? `/api/memories?${qs}` : "/api/memories");
}

export function createMemory(conn: Connection, req: CreateMemoryRequest): Promise<Memory> {
  return apiFetch(conn, "/api/memories", { method: "POST", body: JSON.stringify(req) });
}

export function updateMemory(conn: Connection, id: string, patch: Partial<CreateMemoryRequest>): Promise<Memory> {
  return apiFetch(conn, `/api/memories/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function reviewMemory(conn: Connection, id: string, req: MemoryReviewCommand): Promise<Memory> {
  return apiFetch(conn, `/api/memories/${id}/review`, { method: "PATCH", body: JSON.stringify(req) });
}

export function deleteMemory(conn: Connection, id: string): Promise<OkEnvelope> {
  return apiFetch(conn, `/api/memories/${id}`, { method: "DELETE" });
}

export function getRuntimeConfig(conn: Connection): Promise<RuntimeConfigResponse> {
  return apiFetch(conn, "/api/config/runtime");
}

export function patchRuntimeConfig(conn: Connection, overrides: RuntimeOverrides): Promise<RuntimeConfigResponse> {
  return apiFetch(conn, "/api/config/runtime", { method: "PATCH", body: JSON.stringify(overrides) });
}

export function getVapidPublicKey(conn: Connection): Promise<VapidPublicKeyResponse> {
  return apiFetch(conn, "/api/push/vapid-public-key");
}

export function subscribePush(conn: Connection, sub: PushSubscriptionInfo): Promise<OkEnvelope> {
  return apiFetch(conn, "/api/push-subscribe", { method: "POST", body: JSON.stringify(sub) });
}

export function unsubscribePush(conn: Connection, endpoint: string): Promise<OkEnvelope> {
  return apiFetch(conn, "/api/push-subscribe", { method: "DELETE", body: JSON.stringify({ endpoint }) });
}

export function getStats(conn: Connection): Promise<GlobalStats> {
  return apiFetch(conn, "/api/stats");
}

export function getStatsModes(conn: Connection): Promise<ModeStats> {
  return apiFetch(conn, "/api/stats/modes");
}

export function getStatsRecent(conn: Connection): Promise<RecentStats> {
  return apiFetch(conn, "/api/stats/recent");
}

export function getReadinessSummary(conn: Connection): Promise<ReadinessSummary> {
  return apiFetch(conn, "/api/readiness/summary");
}

export function getAuditEvents(conn: Connection, cursor?: string): Promise<ListEnvelope<AuditEvent>> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return apiFetch(conn, `/api/audit/events${q}`);
}

export function getVersion(conn: Connection): Promise<VersionInfo> {
  return apiFetch(conn, "/api/version");
}

export function getHealth(conn: Connection): Promise<{ ok: true }> {
  return apiFetch(conn, "/api/health");
}

export function postVariants(conn: Connection, req: CreateVariantsRequest): Promise<CreateVariantsResponse> {
  return apiFetch(conn, "/api/sessions/variants", { method: "POST", body: JSON.stringify(req) });
}

export function postEntrypoint(conn: Connection, req: RegisterEntrypointRequest): Promise<Entrypoint> {
  return apiFetch(conn, "/api/entrypoints", { method: "POST", body: JSON.stringify(req) });
}

export function listLoops(conn: Connection): Promise<ListEnvelope<LoopDefinition>> {
  return apiFetch(conn, "/api/loops");
}

export function upsertLoop(conn: Connection, loop: Omit<LoopDefinition, "id" | "createdAt" | "updatedAt" | "consecutiveFailures">): Promise<LoopDefinition> {
  return apiFetch(conn, "/api/loops", { method: "POST", body: JSON.stringify(loop) });
}

export interface UploadResponse {
  url: string;
  name: string;
  mimeType: string;
  byteSize: number;
}

export function fetchCleanupCandidates(
  conn: Connection,
  opts: { olderThanDays: number; statuses: CleanupableStatus[] },
): Promise<CleanupCandidatesResponse> {
  const qs = `olderThanDays=${opts.olderThanDays}&statuses=${opts.statuses.join(",")}`;
  return apiFetch<CleanupCandidatesResponse>(conn, `/api/cleanup/candidates?${qs}`);
}

export function previewCleanup(
  conn: Connection,
  req: CleanupPreviewRequest,
): Promise<CleanupPreviewResponse> {
  return apiFetch<CleanupPreviewResponse>(conn, "/api/cleanup/preview", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function executeCleanup(
  conn: Connection,
  req: CleanupExecuteRequest,
): Promise<CleanupExecuteResponse> {
  return apiFetch<CleanupExecuteResponse>(conn, "/api/cleanup/execute", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function uploadAttachment(conn: Connection, file: File): Promise<UploadResponse> {
  const url = `${conn.baseUrl.replace(/\/$/, "")}/api/uploads`;
  const fd = new FormData();
  fd.set("file", file);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${conn.token}` },
    body: fd,
  });
  if (!res.ok) {
    let body: { error: string; message: string; detail?: Record<string, unknown> };
    try {
      body = await res.json() as typeof body;
    } catch {
      body = { error: "unknown", message: res.statusText };
    }
    throw new ApiError(res.status, body);
  }
  return res.json() as Promise<UploadResponse>;
}
