import type { Session } from "./session.js";
import type { TranscriptEvent } from "./transcript.js";
import type { DAG, DAGNode } from "./dag.js";
import type { Memory } from "./memory.js";
import type { ResourceSnapshot } from "./resource.js";

export interface SessionCreatedEvent {
  kind: "session_created";
  session: Session;
}

export interface SessionUpdatedEvent {
  kind: "session_updated";
  session: Session;
}

export interface SessionDeletedEvent {
  kind: "session_deleted";
  slug: string;
}

export interface DagCreatedEvent {
  kind: "dag_created";
  dag: DAG;
}

export interface DagUpdatedEvent {
  kind: "dag_updated";
  dag: DAG;
}

export interface DagDeletedEvent {
  kind: "dag_deleted";
  id: string;
}

export interface DagNodeUpdatedEvent {
  kind: "dag_node_updated";
  dagId: string;
  node: DAGNode;
}

export interface TranscriptEventEvent {
  kind: "transcript_event";
  sessionSlug: string;
  event: TranscriptEvent;
}

export interface ResourceEvent {
  kind: "resource";
  snapshot: ResourceSnapshot;
}

export interface SessionScreenshotCapturedEvent {
  kind: "session_screenshot_captured";
  sessionSlug: string;
  filename: string;
  url: string;
  capturedAt: string;
  description?: string;
}

export interface MemoryProposedEvent {
  kind: "memory_proposed";
  memory: Memory;
}

export interface MemoryUpdatedEvent {
  kind: "memory_updated";
  memory: Memory;
}

export interface MemoryReviewedEvent {
  kind: "memory_reviewed";
  memory: Memory;
}

export interface MemoryDeletedEvent {
  kind: "memory_deleted";
  id: string;
}

export interface HelloEvent {
  kind: "hello";
  serverTime: string;
  apiVersion: string;
}

export interface PingEvent {
  kind: "ping";
  serverTime: string;
}

export type ServerEvent =
  | HelloEvent
  | PingEvent
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SessionDeletedEvent
  | DagCreatedEvent
  | DagUpdatedEvent
  | DagDeletedEvent
  | DagNodeUpdatedEvent
  | TranscriptEventEvent
  | ResourceEvent
  | SessionScreenshotCapturedEvent
  | MemoryProposedEvent
  | MemoryUpdatedEvent
  | MemoryReviewedEvent
  | MemoryDeletedEvent;

export type ServerEventKind = ServerEvent["kind"];
