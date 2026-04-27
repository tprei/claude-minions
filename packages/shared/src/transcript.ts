export type ToolKind =
  | "read"
  | "write"
  | "edit"
  | "shell"
  | "search"
  | "glob"
  | "web"
  | "browser"
  | "notebook"
  | "mcp"
  | "todo"
  | "other";

export type ToolResultStatus = "ok" | "error" | "partial";
export type ToolResultFormat = "text" | "markdown" | "diff" | "json" | "image" | "binary";

interface BaseEvent {
  id: string;
  sessionSlug: string;
  seq: number;
  turn: number;
  timestamp: string;
}

export interface UserMessageEvent extends BaseEvent {
  kind: "user_message";
  text: string;
  attachments?: { name: string; mimeType: string; url?: string }[];
  source?: "operator" | "external" | "loop" | "completion";
  injected?: boolean;
}

export interface TurnStartedEvent extends BaseEvent {
  kind: "turn_started";
  reason?: "user" | "resume" | "completion" | "loop";
}

export interface TurnCompletedEvent extends BaseEvent {
  kind: "turn_completed";
  outcome: "success" | "stopped" | "errored" | "needs_input";
  stopReason?: string;
}

export interface AssistantTextEvent extends BaseEvent {
  kind: "assistant_text";
  text: string;
  partial?: boolean;
}

export interface ThinkingEvent extends BaseEvent {
  kind: "thinking";
  text: string;
}

export interface ToolCallEvent extends BaseEvent {
  kind: "tool_call";
  toolCallId: string;
  toolName: string;
  toolKind: ToolKind;
  summary: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent extends BaseEvent {
  kind: "tool_result";
  toolCallId: string;
  toolName?: string;
  toolKind?: ToolKind;
  status: ToolResultStatus;
  format: ToolResultFormat;
  body: string;
  truncated?: boolean;
  byteSize?: number;
}

export interface StatusEvent extends BaseEvent {
  kind: "status";
  level: "info" | "warn" | "error";
  text: string;
  data?: Record<string, unknown>;
}

export type TranscriptEvent =
  | UserMessageEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | AssistantTextEvent
  | ThinkingEvent
  | ToolCallEvent
  | ToolResultEvent
  | StatusEvent;

export type TranscriptEventKind = TranscriptEvent["kind"];
