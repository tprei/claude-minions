// Converts a ProviderEvent (from the engine's workflow SSE stream) into a
// TranscriptEvent (the shape the Transcript renderer expects).
//
// ProviderEvent is a discriminated union from @minions/engine's provider-plugin.
// TranscriptEvent is from @minions/shared's transcript module.
//
// Mapping notes:
//   assistant_text → AssistantTextEvent  (direct)
//   thinking       → ThinkingEvent       (direct)
//   tool_call      → ToolCallEvent       (id maps to toolCallId; name maps to toolName;
//                                         toolKind inferred as "other"; summary derived from name)
//   tool_result    → ToolResultEvent     (id maps to toolCallId; output serialized to string;
//                                         isError maps to status "error" vs "ok"; format is "text")
//   usage          → null (no TranscriptEvent shape for usage)
//   final          → null (session bookkeeping, not displayed)
//   error          → StatusEvent (level "error", text from message)
//   permission_request → null (not currently displayed)

import type { ProviderEvent } from "@minions/engine";
import type { TranscriptEvent } from "@minions/shared";

let seq = 0;

function nextSeq(): number {
  return ++seq;
}

function syntheticId(kind: string): string {
  return `${kind}-${Date.now()}-${nextSeq()}`;
}

export function providerEventToTranscript(
  event: ProviderEvent,
  sessionSlug: string,
  turn: number,
  timestamp: string,
): TranscriptEvent | null {
  const base = { sessionSlug, turn, timestamp };

  switch (event.kind) {
    case "assistant_text":
      return {
        ...base,
        kind: "assistant_text",
        id: syntheticId("assistant_text"),
        seq: nextSeq(),
        text: event.text,
      };

    case "thinking":
      return {
        ...base,
        kind: "thinking",
        id: syntheticId("thinking"),
        seq: nextSeq(),
        text: event.text,
      };

    case "tool_call":
      return {
        ...base,
        kind: "tool_call",
        id: syntheticId("tool_call"),
        seq: nextSeq(),
        toolCallId: event.id,
        toolName: event.name,
        toolKind: "other",
        summary: event.name,
        input: (typeof event.input === "object" && event.input !== null)
          ? (event.input as Record<string, unknown>)
          : {},
      };

    case "tool_result": {
      const body = typeof event.output === "string"
        ? event.output
        : JSON.stringify(event.output);
      return {
        ...base,
        kind: "tool_result",
        id: syntheticId("tool_result"),
        seq: nextSeq(),
        toolCallId: event.id,
        status: event.isError === true ? "error" : "ok",
        format: "text",
        body,
      };
    }

    case "error":
      return {
        ...base,
        kind: "status",
        id: syntheticId("status"),
        seq: nextSeq(),
        level: "error",
        text: event.message,
        ...(event.source !== undefined ? { data: { source: event.source } } : {}),
      };

    case "usage":
    case "final":
    case "permission_request":
      return null;
  }
}
