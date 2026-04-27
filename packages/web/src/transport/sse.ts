import type { Connection } from "../connections/store.js";
import type {
  ServerEventKind,
  SessionCreatedEvent,
  SessionUpdatedEvent,
  SessionDeletedEvent,
  DagCreatedEvent,
  DagUpdatedEvent,
  DagDeletedEvent,
  TranscriptEventEvent,
  ResourceEvent,
  SessionScreenshotCapturedEvent,
  MemoryProposedEvent,
  MemoryUpdatedEvent,
  MemoryReviewedEvent,
  MemoryDeletedEvent,
  HelloEvent,
  PingEvent,
} from "../types.js";

export interface SseHandlers {
  onHello?: (e: HelloEvent) => void;
  onPing?: (e: PingEvent) => void;
  onSessionCreated?: (e: SessionCreatedEvent) => void;
  onSessionUpdated?: (e: SessionUpdatedEvent) => void;
  onSessionDeleted?: (e: SessionDeletedEvent) => void;
  onDagCreated?: (e: DagCreatedEvent) => void;
  onDagUpdated?: (e: DagUpdatedEvent) => void;
  onDagDeleted?: (e: DagDeletedEvent) => void;
  onTranscriptEvent?: (e: TranscriptEventEvent) => void;
  onResource?: (e: ResourceEvent) => void;
  onSessionScreenshotCaptured?: (e: SessionScreenshotCapturedEvent) => void;
  onMemoryProposed?: (e: MemoryProposedEvent) => void;
  onMemoryUpdated?: (e: MemoryUpdatedEvent) => void;
  onMemoryReviewed?: (e: MemoryReviewedEvent) => void;
  onMemoryDeleted?: (e: MemoryDeletedEvent) => void;
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

export function connectSse(conn: Connection, handlers: SseHandlers): SseConnection {
  let es: EventSource | null = null;
  let attempt = 0;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function open(): void {
    if (closed) return;
    const url = `${conn.baseUrl.replace(/\/$/, "")}/api/events?token=${encodeURIComponent(conn.token)}`;
    es = new EventSource(url);

    const kinds: ServerEventKind[] = [
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

    for (const kind of kinds) {
      es.addEventListener(kind, (raw: MessageEvent) => {
        let data: unknown;
        try {
          data = JSON.parse(raw.data as string);
        } catch {
          return;
        }
        dispatch(kind, data);
      });
    }

    es.addEventListener("open", () => {
      attempt = 0;
      handlers.onReconnect?.();
    });

    es.addEventListener("error", () => {
      es?.close();
      es = null;
      if (closed) return;
      const delay = fullJitter(attempt++);
      retryTimer = setTimeout(open, delay);
    });
  }

  function dispatch(kind: ServerEventKind, data: unknown): void {
    switch (kind) {
      case "hello": handlers.onHello?.(data as HelloEvent); break;
      case "ping": handlers.onPing?.(data as PingEvent); break;
      case "session_created": handlers.onSessionCreated?.(data as SessionCreatedEvent); break;
      case "session_updated": handlers.onSessionUpdated?.(data as SessionUpdatedEvent); break;
      case "session_deleted": handlers.onSessionDeleted?.(data as SessionDeletedEvent); break;
      case "dag_created": handlers.onDagCreated?.(data as DagCreatedEvent); break;
      case "dag_updated": handlers.onDagUpdated?.(data as DagUpdatedEvent); break;
      case "dag_deleted": handlers.onDagDeleted?.(data as DagDeletedEvent); break;
      case "transcript_event": handlers.onTranscriptEvent?.(data as TranscriptEventEvent); break;
      case "resource": handlers.onResource?.(data as ResourceEvent); break;
      case "session_screenshot_captured": handlers.onSessionScreenshotCaptured?.(data as SessionScreenshotCapturedEvent); break;
      case "memory_proposed": handlers.onMemoryProposed?.(data as MemoryProposedEvent); break;
      case "memory_updated": handlers.onMemoryUpdated?.(data as MemoryUpdatedEvent); break;
      case "memory_reviewed": handlers.onMemoryReviewed?.(data as MemoryReviewedEvent); break;
      case "memory_deleted": handlers.onMemoryDeleted?.(data as MemoryDeletedEvent); break;
    }
  }

  open();

  return {
    close() {
      closed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      es?.close();
      es = null;
    },
  };
}
