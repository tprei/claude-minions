import type { Connection } from "../connections/store.js";
import { sseStatusStore, type SseStatus } from "./sseStatus.js";
import type { WorkflowEvent, WorkflowEventKind } from "@minions/engine";

export type { WorkflowEvent, WorkflowEventKind };

export interface WorkflowSseHandlers {
  onEvent?: (e: WorkflowEvent) => void;
  onReconnect?: () => void;
}

export interface SseConnection {
  close: () => void;
}

const BASE_DELAY_MS = 1000;
const CAP_DELAY_MS = 30_000;

function fullJitter(attempt: number): number {
  const ceiling = Math.min(CAP_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

const WORKFLOW_EVENT_KINDS: WorkflowEventKind[] = [
  "task-transitioned",
  "graph-operation-changed",
  "run-started",
  "run-ended",
  "workflow-status-changed",
  "provider-event",
  "merge-phase",
  "ci-poll-result",
];

const WORKFLOW_EVENT_KIND_SET = new Set<string>(WORKFLOW_EVENT_KINDS);

function findMessageBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) {
    return crlf === -1 ? null : { index: crlf, length: 4 };
  }
  if (crlf === -1 || lf < crlf) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

function parseSseMessage(message: string): { event: string; data: string; id?: string } | null {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? "" : line.slice(idx + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n"), ...(id !== undefined ? { id } : {}) };
}

export function connectWorkflowSse(
  conn: Connection,
  workflowId: string,
  handlers: WorkflowSseHandlers,
): SseConnection {
  let controller: AbortController | null = null;
  let attempt = 0;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastCursor: number | null = null;
  let hasOpened = false;
  const cleanups: Array<() => void> = [];

  const connKey = `${conn.id}:${workflowId}`;

  function setStatus(status: SseStatus): void {
    sseStatusStore.set(connKey, status);
  }

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (closed) return;
    setStatus(attempt >= 3 ? "down" : "reconnecting");
    const delay = fullJitter(attempt++);
    retryTimer = setTimeout(open, delay);
  }

  function dispatchMessage(message: string): void {
    const parsed = parseSseMessage(message);
    if (!parsed || !WORKFLOW_EVENT_KIND_SET.has(parsed.event)) return;
    let data: unknown;
    try {
      data = JSON.parse(parsed.data);
    } catch {
      return;
    }
    if (parsed.id !== undefined && /^\d+$/.test(parsed.id)) {
      const cursor = Number(parsed.id);
      if (Number.isSafeInteger(cursor)) lastCursor = cursor;
    }
    handlers.onEvent?.(data as WorkflowEvent);
  }

  async function consume(ac: AbortController): Promise<void> {
    const path = `/workflows/${encodeURIComponent(workflowId)}/events`;
    const qs = lastCursor !== null ? `?since=${lastCursor}` : "";
    const url = `${conn.baseUrl.replace(/\/$/, "")}${path}${qs}`;
    const headers = new Headers({ Accept: "text/event-stream" });
    const token = conn.token.trim();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(url, { headers, signal: ac.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`SSE connection failed: ${res.status}`);
    if (!res.body) throw new Error("SSE connection did not provide a response body");
    if (controller !== ac || closed) return;
    attempt = 0;
    setStatus("open");
    if (hasOpened) {
      handlers.onReconnect?.();
    } else {
      hasOpened = true;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const boundary = findMessageBoundary(buffer);
          if (!boundary) break;
          const message = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          dispatchMessage(message);
        }
      }
      buffer += decoder.decode();
      if (buffer.length > 0) dispatchMessage(buffer);
      throw new Error("SSE connection closed");
    } finally {
      reader.releaseLock();
    }
  }

  function open(): void {
    if (closed) return;
    setStatus(attempt === 0 ? "connecting" : "reconnecting");
    const ac = new AbortController();
    controller = ac;
    void consume(ac).catch(() => {
      if (closed || controller !== ac) return;
      controller = null;
      scheduleReconnect();
    });
  }

  function forceReconnect(): void {
    if (closed) return;
    clearRetryTimer();
    controller?.abort();
    controller = null;
    attempt = 0;
    open();
  }

  sseStatusStore.registerReconnect(connKey, forceReconnect);

  if (typeof window !== "undefined") {
    const onVisibility = (): void => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        forceReconnect();
      }
    };
    const onOnline = (): void => {
      forceReconnect();
    };
    const onPageShow = (): void => {
      forceReconnect();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
      cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));
    }
    window.addEventListener("online", onOnline);
    window.addEventListener("pageshow", onPageShow);
    cleanups.push(() => window.removeEventListener("online", onOnline));
    cleanups.push(() => window.removeEventListener("pageshow", onPageShow));
  }

  open();

  return {
    close() {
      closed = true;
      clearRetryTimer();
      controller?.abort();
      controller = null;
      for (const fn of cleanups) fn();
      cleanups.length = 0;
      sseStatusStore.clear(connKey);
      sseStatusStore.unregisterReconnect(connKey, forceReconnect);
    },
  };
}
