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

export function connectWorkflowSse(
  conn: Connection,
  workflowId: string,
  handlers: WorkflowSseHandlers,
): SseConnection {
  let es: EventSource | null = null;
  let attempt = 0;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
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

  function open(): void {
    if (closed) return;
    setStatus(attempt === 0 ? "connecting" : "reconnecting");
    const url = `${conn.baseUrl.replace(/\/$/, "")}/workflows/${encodeURIComponent(workflowId)}/events`;
    es = new EventSource(url);

    for (const kind of WORKFLOW_EVENT_KINDS) {
      es.addEventListener(kind, (raw: MessageEvent) => {
        let data: unknown;
        try {
          data = JSON.parse(raw.data as string);
        } catch {
          return;
        }
        handlers.onEvent?.(data as WorkflowEvent);
      });
    }

    es.addEventListener("open", () => {
      attempt = 0;
      setStatus("open");
      handlers.onReconnect?.();
    });

    es.addEventListener("error", () => {
      es?.close();
      es = null;
      if (closed) return;
      setStatus(attempt >= 3 ? "down" : "reconnecting");
      const delay = fullJitter(attempt++);
      retryTimer = setTimeout(open, delay);
    });
  }

  function forceReconnect(): void {
    if (closed) return;
    clearRetryTimer();
    es?.close();
    es = null;
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
      es?.close();
      es = null;
      for (const fn of cleanups) fn();
      cleanups.length = 0;
      sseStatusStore.clear(connKey);
      sseStatusStore.unregisterReconnect(connKey);
    },
  };
}
