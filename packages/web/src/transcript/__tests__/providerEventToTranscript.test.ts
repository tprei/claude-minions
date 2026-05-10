import { describe, it, expect } from "vitest";
import type { ProviderEvent } from "@minions/engine";
import { providerEventToTranscript } from "../providerEventToTranscript.js";

const SESSION = "wf-1:task-1";
const TURN = 1;
const TS = "2026-05-10T00:00:00.000Z";

function convert(event: ProviderEvent) {
  return providerEventToTranscript(event, SESSION, TURN, TS);
}

describe("providerEventToTranscript", () => {
  it("maps assistant_text to AssistantTextEvent", () => {
    const result = convert({ kind: "assistant_text", text: "Hello" });
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("assistant_text");
    expect((result as { text: string }).text).toBe("Hello");
    expect(result?.sessionSlug).toBe(SESSION);
    expect(result?.turn).toBe(TURN);
    expect(result?.timestamp).toBe(TS);
  });

  it("maps thinking to ThinkingEvent", () => {
    const result = convert({ kind: "thinking", text: "Let me think…" });
    expect(result?.kind).toBe("thinking");
    expect((result as { text: string }).text).toBe("Let me think…");
  });

  it("maps tool_call to ToolCallEvent", () => {
    const result = convert({
      kind: "tool_call",
      id: "tc-1",
      name: "Bash",
      input: { command: "ls" },
    });
    expect(result?.kind).toBe("tool_call");
    const tc = result as { toolCallId: string; toolName: string; toolKind: string; input: unknown; summary: string };
    expect(tc.toolCallId).toBe("tc-1");
    expect(tc.toolName).toBe("Bash");
    expect(tc.toolKind).toBe("other");
    expect(tc.summary).toBe("Bash");
    expect(tc.input).toEqual({ command: "ls" });
  });

  it("maps tool_result with string output to ToolResultEvent", () => {
    const result = convert({ kind: "tool_result", id: "tc-1", output: "hello world" });
    expect(result?.kind).toBe("tool_result");
    const tr = result as { toolCallId: string; status: string; format: string; body: string };
    expect(tr.toolCallId).toBe("tc-1");
    expect(tr.status).toBe("ok");
    expect(tr.format).toBe("text");
    expect(tr.body).toBe("hello world");
  });

  it("maps tool_result with object output to JSON string body", () => {
    const result = convert({ kind: "tool_result", id: "tc-2", output: { files: ["a.ts"] } });
    const tr = result as { body: string };
    expect(tr.body).toBe(JSON.stringify({ files: ["a.ts"] }));
  });

  it("sets status=error when isError is true on tool_result", () => {
    const result = convert({ kind: "tool_result", id: "tc-3", output: "boom", isError: true });
    const tr = result as { status: string };
    expect(tr.status).toBe("error");
  });

  it("maps error to StatusEvent with level error", () => {
    const result = convert({ kind: "error", recoverable: false, message: "something failed", source: "tool" });
    expect(result?.kind).toBe("status");
    const s = result as { level: string; text: string; data?: Record<string, unknown> };
    expect(s.level).toBe("error");
    expect(s.text).toBe("something failed");
    expect(s.data?.["source"]).toBe("tool");
  });

  it("returns null for usage events", () => {
    expect(convert({ kind: "usage", inputTokens: 10, outputTokens: 5 })).toBeNull();
  });

  it("returns null for final events", () => {
    expect(convert({ kind: "final", sessionRef: "abc123" })).toBeNull();
  });

  it("returns null for permission_request events", () => {
    expect(convert({ kind: "permission_request", id: "p-1", tool: "Bash", input: {} })).toBeNull();
  });
});
