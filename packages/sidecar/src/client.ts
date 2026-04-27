import EventSource from "eventsource";
import type {
  AuditEvent,
  Command,
  CommandResult,
  CreateSessionRequest,
  DAG,
  ListEnvelope,
  MergeReadiness,
  RuntimeConfigResponse,
  RuntimeOverrides,
  ServerEvent,
  ServerEventKind,
  Session,
  TranscriptEvent,
} from "@minions/shared";
import type { Logger } from "./log.js";

export interface SseHandlers {
  onAny?: (event: ServerEvent) => void | Promise<void>;
  onOpen?: () => void;
  onError?: (err: unknown) => void;
}

export interface SseSubscription {
  close(): void;
}

const SSE_KINDS: ServerEventKind[] = [
  "hello",
  "ping",
  "session_created",
  "session_updated",
  "session_deleted",
  "dag_created",
  "dag_updated",
  "dag_deleted",
  "transcript_event",
  "resource",
  "session_screenshot_captured",
  "memory_proposed",
  "memory_updated",
  "memory_reviewed",
  "memory_deleted",
];

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;

function fullJitter(attempt: number): number {
  const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

export interface SidecarClientOptions {
  baseUrl: string;
  token: string;
  log: Logger;
}

export class SidecarClient {
  readonly baseUrl: string;
  readonly token: string;
  readonly log: Logger;

  constructor(opts: SidecarClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.log = opts.log;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      ...extra,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: this.headers(body !== undefined ? { "Content-Type": "application/json" } : undefined),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`engine ${method} ${path} failed: ${res.status} ${res.statusText} ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getSessions(): Promise<Session[]> {
    const items: Session[] = [];
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ limit: "200" });
      if (cursor) qs.set("cursor", cursor);
      const page = await this.request<ListEnvelope<Session>>("GET", `/api/sessions?${qs.toString()}`);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  async getSession(slug: string): Promise<Session> {
    return this.request<Session>("GET", `/api/sessions/${encodeURIComponent(slug)}`);
  }

  async getTranscript(slug: string): Promise<TranscriptEvent[]> {
    const env = await this.request<{ items: TranscriptEvent[] }>(
      "GET",
      `/api/sessions/${encodeURIComponent(slug)}/transcript`,
    );
    return env.items;
  }

  async getDags(): Promise<DAG[]> {
    const env = await this.request<{ items: DAG[] }>("GET", `/api/dags`);
    return env.items;
  }

  async getReadiness(slug: string): Promise<MergeReadiness> {
    return this.request<MergeReadiness>(
      "GET",
      `/api/sessions/${encodeURIComponent(slug)}/readiness`,
    );
  }

  async getAuditEvents(limit = 200): Promise<AuditEvent[]> {
    const env = await this.request<{ items: AuditEvent[] }>(
      "GET",
      `/api/audit/events?limit=${limit}`,
    );
    return env.items;
  }

  async createSession(req: CreateSessionRequest): Promise<Session> {
    return this.request<Session>("POST", `/api/sessions`, req);
  }

  async postCommand(cmd: Command): Promise<CommandResult> {
    return this.request<CommandResult>("POST", `/api/commands`, cmd);
  }

  async patchRuntimeConfig(patch: RuntimeOverrides): Promise<RuntimeConfigResponse> {
    return this.request<RuntimeConfigResponse>("PATCH", `/api/config/runtime`, patch);
  }

  subscribeEvents(handlers: SseHandlers): SseSubscription {
    let es: EventSource | null = null;
    let attempt = 0;
    let closed = false;
    let retryTimer: NodeJS.Timeout | null = null;

    const open = (): void => {
      if (closed) return;
      const url = `${this.baseUrl}/api/events`;
      es = new EventSource(url, {
        headers: { Authorization: `Bearer ${this.token}` },
      } as unknown as EventSource.EventSourceInitDict);

      for (const kind of SSE_KINDS) {
        es.addEventListener(kind, (raw: MessageEvent) => {
          let data: unknown;
          try {
            data = JSON.parse(raw.data as string);
          } catch (err) {
            this.log.warn("sse parse failed", { kind, err: String(err) });
            return;
          }
          void Promise.resolve(handlers.onAny?.(data as ServerEvent)).catch((err) => {
            this.log.error("sse handler threw", { kind, err: String(err) });
          });
        });
      }

      es.addEventListener("open", () => {
        attempt = 0;
        handlers.onOpen?.();
      });

      es.addEventListener("error", (err: unknown) => {
        handlers.onError?.(err);
        es?.close();
        es = null;
        if (closed) return;
        const delay = fullJitter(attempt++);
        this.log.warn("sse disconnected, reconnecting", { attempt, delayMs: Math.round(delay) });
        retryTimer = setTimeout(open, delay);
      });
    };

    open();

    return {
      close: () => {
        closed = true;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        es?.close();
        es = null;
      },
    };
  }
}
