import { describe, expect, it } from "vitest";
import type { TranscriptEvent, TranscriptEventKind } from "@minions/shared";
import { pickComponent } from "./index.js";

const BASE = {
  id: "e1",
  sessionSlug: "s1",
  seq: 1,
  turn: 1,
  timestamp: "2026-05-13T00:00:00.000Z",
};

function eventFor(kind: TranscriptEventKind): TranscriptEvent {
  switch (kind) {
    case "user_message":
      return { ...BASE, kind, text: "hello" };
    case "turn_started":
      return { ...BASE, kind };
    case "turn_completed":
      return { ...BASE, kind, outcome: "success" };
    case "assistant_text":
      return { ...BASE, kind, text: "hello" };
    case "thinking":
      return { ...BASE, kind, text: "thinking" };
    case "usage":
      return { ...BASE, kind, inputTokens: 10, outputTokens: 5 };
    case "tool_call":
      return { ...BASE, kind, toolCallId: "tc1", toolName: "read", toolKind: "read", summary: "read", input: {} };
    case "tool_result":
      return { ...BASE, kind, toolCallId: "tc1", status: "ok", format: "text", body: "ok" };
    case "status":
      return { ...BASE, kind, level: "info", text: "ok" };
    default:
      return assertNever(kind);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled transcript event kind: ${String(value)}`);
}

describe("transcript event renderer exhaustiveness", () => {
  it("picks a renderer for every transcript event kind", () => {
    const kinds: TranscriptEventKind[] = [
      "user_message",
      "turn_started",
      "turn_completed",
      "assistant_text",
      "thinking",
      "usage",
      "tool_call",
      "tool_result",
      "status",
    ];

    for (const kind of kinds) {
      expect(pickComponent(eventFor(kind))).toBeTypeOf("function");
    }
  });
});
