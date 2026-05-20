import { describe, it, expect } from "vitest";
import type { ProviderEvent } from "@minions/shared";
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

  it("normalizes command_execution tool calls to shell transcript events", () => {
    const result = convert({
      kind: "tool_call",
      id: "tc-shell",
      name: "command_execution",
      input: ["ls", "-la"],
    });
    expect(result?.kind).toBe("tool_call");
    const tc = result as { toolCallId: string; toolName: string; toolKind: string; input: unknown; summary: string };
    expect(tc.toolCallId).toBe("tc-shell");
    expect(tc.toolName).toBe("Bash");
    expect(tc.toolKind).toBe("shell");
    expect(tc.summary).toBe("Bash");
    expect(tc.input).toEqual({ command: "ls -la" });
  });

  it("normalizes read_file tool calls to transcript-native file inputs", () => {
    const result = convert({
      kind: "tool_call",
      id: "tc-read",
      name: "read_file",
      input: { path: "/tmp/foo.ts" },
    });
    expect(result?.kind).toBe("tool_call");
    const tc = result as { toolName: string; toolKind: string; input: unknown };
    expect(tc.toolName).toBe("Read");
    expect(tc.toolKind).toBe("read");
    expect(tc.input).toEqual({ path: "/tmp/foo.ts", file_path: "/tmp/foo.ts" });
  });

  it("maps tool_result with string output and preserves inferred tool metadata", () => {
    convert({ kind: "tool_call", id: "tc-plain", name: "bash", input: { command: "ls" } });
    const result = convert({ kind: "tool_result", id: "tc-plain", output: "hello world" });
    expect(result?.kind).toBe("tool_result");
    const tr = result as {
      toolCallId: string;
      toolName?: string;
      toolKind?: string;
      status: string;
      format: string;
      body: string;
    };
    expect(tr.toolCallId).toBe("tc-plain");
    expect(tr.toolName).toBe("Bash");
    expect(tr.toolKind).toBe("shell");
    expect(tr.status).toBe("ok");
    expect(tr.format).toBe("text");
    expect(tr.body).toBe("hello world");
  });

  it("unwraps structured tool_result envelopes to display text", () => {
    convert({ kind: "tool_call", id: "tc-structured", name: "read_file", input: { path: "/tmp/foo.ts" } });
    const result = convert({
      kind: "tool_result",
      id: "tc-structured",
      output: {
        content: [{ type: "text", text: "tool output" }],
        structured_content: { files: ["a.ts"] },
      },
    });
    expect(result?.kind).toBe("tool_result");
    const tr = result as { toolName?: string; toolKind?: string; format: string; body: string };
    expect(tr.toolName).toBe("Read");
    expect(tr.toolKind).toBe("read");
    expect(tr.format).toBe("text");
    expect(tr.body).toBe("tool output");
  });

  it("maps generic object outputs to pretty JSON bodies", () => {
    const result = convert({ kind: "tool_result", id: "tc-json", output: { files: ["a.ts"] } });
    const tr = result as { format: string; body: string };
    expect(tr.format).toBe("json");
    expect(tr.body).toBe(JSON.stringify({ files: ["a.ts"] }, null, 2));
  });

  it("unwraps message-only error envelopes to plain text", () => {
    const result = convert({
      kind: "tool_result",
      id: "tc-message",
      output: { message: "tool not found" },
      isError: true,
    });
    const tr = result as { format: string; body: string; status: string };
    expect(tr.status).toBe("error");
    expect(tr.format).toBe("text");
    expect(tr.body).toBe("tool not found");
  });

  it("sets status=error when isError is true on tool_result", () => {
    const result = convert({ kind: "tool_result", id: "tc-error", output: "boom", isError: true });
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

  it("preserves usage events", () => {
    const result = convert({
      kind: "usage",
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 3,
      reasoningTokens: 2,
      costUsd: 0.25,
    });
    expect(result?.kind).toBe("usage");
    const usage = result as {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      reasoningTokens?: number;
      costUsd?: number;
    };
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(5);
    expect(usage.cachedInputTokens).toBe(3);
    expect(usage.reasoningTokens).toBe(2);
    expect(usage.costUsd).toBe(0.25);
  });

  it("returns null for final events", () => {
    expect(convert({ kind: "final", sessionRef: "abc123" })).toBeNull();
  });

  it("returns null for permission_request events", () => {
    expect(convert({ kind: "permission_request", id: "p-1", tool: "Bash", input: {} })).toBeNull();
  });
});
