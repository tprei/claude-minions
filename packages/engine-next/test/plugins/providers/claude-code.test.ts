import { describe, expect, it, vi, beforeEach } from "vitest";
import { ClaudeCodeProvider } from "../../../src/plugins/providers/claude-code.js";
import type { ProviderEvent } from "../../../src/plugins/provider-plugin.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

function encode(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("ClaudeCodeProvider", () => {
  const provider = new ClaudeCodeProvider();

  it("capability vector has correct literal shape", () => {
    expect(provider.capabilities).toEqual({
      resume: true,
      mcp: true,
      structuredOutput: false,
      oauthLogin: true,
      streamJson: true,
      sessionRefFormat: "uuid",
    });
  });

  it("standard fixture: system init → assistant text → assistant tool_use → user tool_result → result success", () => {
    const systemInit = encode({ type: "system", subtype: "init" });
    const assistantText = encode({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello" }] },
    });
    const assistantToolUse = encode({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "tu1", name: "read_file", input: { path: "/foo" } }],
      },
    });
    const userToolResult = encode({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "file contents", is_error: false }],
      },
    });
    const resultSuccess = encode({
      type: "result",
      subtype: "success",
      session_id: "abc-uuid",
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.0042,
      duration_ms: 1000,
      num_turns: 2,
    });

    expect(provider.parseFrame(systemInit)).toEqual([]);
    expect(provider.parseFrame(assistantText)).toEqual([{ kind: "assistant_text", text: "Hello" }]);
    expect(provider.parseFrame(assistantToolUse)).toEqual([
      { kind: "tool_call", id: "tu1", name: "read_file", input: { path: "/foo" } },
    ]);
    expect(provider.parseFrame(userToolResult)).toEqual([
      { kind: "tool_result", id: "tu1", output: "file contents", isError: false },
    ]);

    const resultEvents = provider.parseFrame(resultSuccess);
    expect(resultEvents).toHaveLength(2);
    expect(resultEvents[0]).toEqual({ kind: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0.0042 });
    expect(resultEvents[1]).toMatchObject({ kind: "final", sessionRef: "abc-uuid" });
  });

  it("result subtype error_max_turns emits error then usage then final", () => {
    const line = encode({
      type: "result",
      subtype: "error_max_turns",
      session_id: "sess-1",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const events = provider.parseFrame(line);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: "error", recoverable: false });
    expect((events[0] as ProviderEvent & { kind: "error" }).message).toContain("error_max_turns");
    expect(events[1]).toMatchObject({ kind: "usage" });
    expect(events[2]).toMatchObject({ kind: "final", sessionRef: "sess-1" });
  });

  it("result subtype success with is_error true emits error then usage then final", () => {
    const line = encode({
      type: "result",
      subtype: "success",
      is_error: true,
      session_id: "sess-err",
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    const events = provider.parseFrame(line);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: "error", recoverable: false });
    expect((events[0] as ProviderEvent & { kind: "error" }).message).toContain("is_error=true");
    expect(events[1]).toMatchObject({ kind: "usage" });
    expect(events[2]).toMatchObject({ kind: "final", sessionRef: "sess-err" });
  });

  it("system api_retry emits recoverable error with source api_retry", () => {
    const line = encode({ type: "system", subtype: "api_retry", message: "retry attempt 1" });
    const events = provider.parseFrame(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "error",
      recoverable: true,
      source: "api_retry",
      message: "retry attempt 1",
    });
  });

  it("assistant content with thinking block emits thinking event", () => {
    const line = encode({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Let me think..." },
          { type: "text", text: "Answer" },
        ],
      },
    });
    const events = provider.parseFrame(line);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ kind: "thinking", text: "Let me think..." });
    expect(events[1]).toEqual({ kind: "assistant_text", text: "Answer" });
  });

  it("unmapped result subtype emits loud error", () => {
    const line = encode({
      type: "result",
      subtype: "something_new",
      session_id: "s",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const events = provider.parseFrame(line);
    expect(events[0]).toMatchObject({ kind: "error", recoverable: false });
    expect((events[0] as ProviderEvent & { kind: "error" }).message).toContain("something_new");
  });

  it("unknown top-level type emits loud error", () => {
    const line = encode({ type: "future_event", data: "xyz" });
    const events = provider.parseFrame(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "error", recoverable: false });
    expect((events[0] as ProviderEvent & { kind: "error" }).message).toContain("future_event");
  });

  it("empty line returns empty array", () => {
    expect(provider.parseFrame("")).toEqual([]);
    expect(provider.parseFrame("   ")).toEqual([]);
  });

  it("plain-text stderr line returns empty array, does not throw", () => {
    expect(provider.parseFrame("Error: authentication failed")).toEqual([]);
    expect(provider.parseFrame("Warning: rate limit approaching")).toEqual([]);
  });

  it("partial JSON that fails to parse returns empty array, does not throw", () => {
    expect(provider.parseFrame("{not valid")).toEqual([]);
  });

  it("stream_event returns empty array", () => {
    const line = encode({ type: "stream_event", data: {} });
    expect(provider.parseFrame(line)).toEqual([]);
  });

  it("rate_limit_event returns empty array (not an error)", () => {
    const line = encode({ type: "rate_limit_event", limit: 1000, remaining: 0 });
    expect(provider.parseFrame(line)).toEqual([]);
  });

  it("result with total_cost_usd propagates costUsd", () => {
    const line = encode({
      type: "result",
      subtype: "success",
      session_id: "s",
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0.001,
    });
    const events = provider.parseFrame(line);
    const usageEvent = events.find((e) => e.kind === "usage") as ProviderEvent & { kind: "usage" };
    expect(usageEvent?.costUsd).toBe(0.001);
  });

  it("result num_turns propagates as numTurns in exitMetadata", () => {
    const line = encode({
      type: "result",
      subtype: "success",
      session_id: "s",
      usage: { input_tokens: 1, output_tokens: 1 },
      num_turns: 3,
    });
    const events = provider.parseFrame(line);
    const finalEvent = events.find((e) => e.kind === "final") as ProviderEvent & { kind: "final" };
    expect((finalEvent?.exitMetadata as Record<string, unknown>)?.["numTurns"]).toBe(3);
  });

  it("result without num_turns leaves numTurns undefined in exitMetadata", () => {
    const line = encode({
      type: "result",
      subtype: "success",
      session_id: "s",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const events = provider.parseFrame(line);
    const finalEvent = events.find((e) => e.kind === "final") as ProviderEvent & { kind: "final" };
    expect((finalEvent?.exitMetadata as Record<string, unknown>)?.["numTurns"]).toBeUndefined();
  });

  it("result without total_cost_usd leaves costUsd undefined", () => {
    const line = encode({
      type: "result",
      subtype: "success",
      session_id: "s",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const events = provider.parseFrame(line);
    const usageEvent = events.find((e) => e.kind === "usage") as ProviderEvent & { kind: "usage" };
    expect(usageEvent?.costUsd).toBeUndefined();
  });

  it("user message tool_result reads from message.content nesting", () => {
    const line = encode({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tr1", content: "ok", is_error: false }],
      },
    });
    const events = provider.parseFrame(line);
    expect(events).toEqual([{ kind: "tool_result", id: "tr1", output: "ok", isError: false }]);
  });

  describe("prepare", () => {
    it("returns correct argv shape", async () => {
      const inv = await provider.prepare({
        taskId: "t1",
        workflowId: "wf1",
        prompt: "fix the bug",
        dependencyArtifacts: [],
      });
      expect(inv.command).toEqual([
        "claude", "-p", "fix the bug", "--output-format", "stream-json", "--verbose",
      ]);
      expect(inv.providerType).toBe("claude-code");
    });

    it("throws when prompt is empty", async () => {
      await expect(
        provider.prepare({ taskId: "t1", workflowId: "wf1", prompt: "", dependencyArtifacts: [] }),
      ).rejects.toThrow("prompt must be non-empty");
    });

    it("throws when prompt is whitespace only", async () => {
      await expect(
        provider.prepare({ taskId: "t1", workflowId: "wf1", prompt: "   ", dependencyArtifacts: [] }),
      ).rejects.toThrow("prompt must be non-empty");
    });
  });

  describe("resume", () => {
    it("returns correct argv shape with prompt and sessionRef", async () => {
      const inv = await provider.resume({
        taskId: "t1",
        workflowId: "wf1",
        sessionRef: "abc-uuid",
        prompt: "continue from here",
      });
      expect(inv.command).toEqual([
        "claude", "-p", "continue from here", "--resume", "abc-uuid", "--output-format", "stream-json", "--verbose",
      ]);
      expect(inv.providerType).toBe("claude-code");
    });

    it("throws when prompt is empty", async () => {
      await expect(
        provider.resume({ taskId: "t1", workflowId: "wf1", sessionRef: "abc-uuid", prompt: "" }),
      ).rejects.toThrow("prompt must be non-empty");
    });

    it("throws when prompt is whitespace only", async () => {
      await expect(
        provider.resume({ taskId: "t1", workflowId: "wf1", sessionRef: "abc-uuid", prompt: "  " }),
      ).rejects.toThrow("prompt must be non-empty");
    });
  });

  describe("loginStatus", () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it("spawn exit 0 → loggedIn true", async () => {
      const { spawn } = await import("node:child_process");
      const mockChild = {
        on: vi.fn((event: string, cb: (code: number | null) => void) => {
          if (event === "close") setTimeout(() => cb(0), 0);
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as unknown as ReturnType<typeof spawn>);

      const result = await new ClaudeCodeProvider().loginStatus();
      expect(result.loggedIn).toBe(true);
    });

    it("spawn exit 1 → loggedIn false", async () => {
      const { spawn } = await import("node:child_process");
      const mockChild = {
        on: vi.fn((event: string, cb: (code: number | null) => void) => {
          if (event === "close") setTimeout(() => cb(1), 0);
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as unknown as ReturnType<typeof spawn>);

      const result = await new ClaudeCodeProvider().loginStatus();
      expect(result.loggedIn).toBe(false);
    });
  });
});
