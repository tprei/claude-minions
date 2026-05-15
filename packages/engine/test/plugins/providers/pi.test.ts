import { describe, expect, it } from "vitest";
import { PiProvider } from "../../../src/plugins/providers/pi.js";
import type { ProviderEvent } from "../../../src/plugins/provider-plugin.js";

function encode(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("PiProvider", () => {
  describe("parseFrame", () => {
    it("standard transcript: session → agent_start → turn_start → message_update text → tool_execution_start/end → turn_end → agent_end", () => {
      const provider = new PiProvider();

      expect(provider.parseFrame(encode({ type: "session", id: "11111111-2222-3333-4444-555555555555" }))).toEqual([]);
      expect(provider.parseFrame(encode({ type: "agent_start" }))).toEqual([]);
      expect(provider.parseFrame(encode({ type: "turn_start" }))).toEqual([]);
      expect(provider.parseFrame(encode({ type: "message_start" }))).toEqual([]);

      const textEvents = provider.parseFrame(
        encode({ type: "message_update", content_block: { type: "text", text: "Hello, world!" } }),
      );
      expect(textEvents).toEqual([{ kind: "assistant_text", text: "Hello, world!" }]);

      const toolStartEvents = provider.parseFrame(
        encode({
          type: "tool_execution_start",
          tool_call_id: "tc-1",
          tool_name: "bash",
          args: { command: "ls" },
        }),
      );
      expect(toolStartEvents).toEqual([
        { kind: "tool_call", id: "tc-1", name: "bash", input: { command: "ls" } },
      ]);

      const toolEndEvents = provider.parseFrame(
        encode({
          type: "tool_execution_end",
          tool_call_id: "tc-1",
          result: "file1\nfile2\n",
          is_error: false,
        }),
      );
      expect(toolEndEvents).toEqual([
        { kind: "tool_result", id: "tc-1", output: "file1\nfile2\n", isError: false },
      ]);

      expect(provider.parseFrame(encode({ type: "turn_end" }))).toEqual([]);

      const agentEndEvents = provider.parseFrame(
        encode({
          type: "agent_end",
          usage: { input_tokens: 10, output_tokens: 20 },
          exit_code: 0,
        }),
      );
      const finalEvents = agentEndEvents.filter((e) => e.kind === "final");
      const usageEvents = agentEndEvents.filter((e) => e.kind === "usage");
      expect(usageEvents).toHaveLength(1);
      expect(finalEvents).toHaveLength(1);
      const finalEvent = finalEvents[0] as ProviderEvent & { kind: "final" };
      expect(finalEvent.sessionRef).toBe("11111111-2222-3333-4444-555555555555");
    });

    it("second session header on the same instance throws", () => {
      const provider = new PiProvider();
      provider.parseFrame(encode({ type: "session", id: "session-1" }));
      expect(() =>
        provider.parseFrame(encode({ type: "session", id: "session-2" })),
      ).toThrow("PiProvider instance reused across conversations");
    });

    it("tool_execution_end with is_error:true propagates isError", () => {
      const provider = new PiProvider();
      const events = provider.parseFrame(
        encode({
          type: "tool_execution_end",
          tool_call_id: "tc-2",
          result: "command failed",
          is_error: true,
        }),
      );
      expect(events).toEqual([
        { kind: "tool_result", id: "tc-2", output: "command failed", isError: true },
      ]);
    });

    it("thinking content block emits thinking event", () => {
      const provider = new PiProvider();
      const events = provider.parseFrame(
        encode({
          type: "message_end",
          content_block: { type: "thinking", text: "I am reasoning..." },
        }),
      );
      expect(events).toEqual([{ kind: "thinking", text: "I am reasoning..." }]);
    });

    it("auto_retry_start emits recoverable error with source auto_retry", () => {
      const provider = new PiProvider();
      const events = provider.parseFrame(
        encode({ type: "auto_retry_start", message: "transient network failure, retrying" }),
      );
      expect(events).toEqual([
        {
          kind: "error",
          recoverable: true,
          source: "auto_retry",
          message: "transient network failure, retrying",
        },
      ]);
    });

    it("auto_retry_end with success:false emits recoverable error with source auto_retry_end", () => {
      const provider = new PiProvider();
      const events = provider.parseFrame(
        encode({ type: "auto_retry_end", success: false, message: "retries exhausted" }),
      );
      expect(events).toEqual([
        {
          kind: "error",
          recoverable: true,
          source: "auto_retry_end",
          message: "retries exhausted",
        },
      ]);
    });

    it("auto_retry_end with success:true emits no error", () => {
      const provider = new PiProvider();
      const events = provider.parseFrame(
        encode({ type: "auto_retry_end", success: true, message: "recovered" }),
      );
      expect(events).toEqual([]);
    });

    it("agent_end emits exactly one usage and one final, including cached + reasoning + cost tokens when present", () => {
      const provider = new PiProvider();
      provider.parseFrame(encode({ type: "session", id: "sess-xyz" }));
      const events = provider.parseFrame(
        encode({
          type: "agent_end",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cached_input_tokens: 40,
            reasoning_tokens: 10,
            cost_usd: 0.42,
          },
          exit_code: 0,
        }),
      );
      expect(events).toHaveLength(2);
      const usage = events.find((e) => e.kind === "usage") as ProviderEvent & { kind: "usage" };
      expect(usage).toMatchObject({
        kind: "usage",
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 40,
        reasoningTokens: 10,
        costUsd: 0.42,
      });
      const finalEvent = events.find((e) => e.kind === "final") as ProviderEvent & { kind: "final" };
      expect(finalEvent.sessionRef).toBe("sess-xyz");
      expect(finalEvent.exitMetadata).toMatchObject({ exit_code: 0 });
    });

    it("agent_end without prior session header emits final with empty sessionRef", () => {
      const provider = new PiProvider();
      const events = provider.parseFrame(
        encode({ type: "agent_end", usage: { input_tokens: 0, output_tokens: 0 } }),
      );
      const finalEvent = events.find((e) => e.kind === "final") as ProviderEvent & { kind: "final" };
      expect(finalEvent.sessionRef).toBe("");
    });

    it("agent_end without cached/reasoning/cost omits those fields from usage", () => {
      const provider = new PiProvider();
      const events = provider.parseFrame(
        encode({ type: "agent_end", usage: { input_tokens: 5, output_tokens: 7 } }),
      );
      const usage = events.find((e) => e.kind === "usage") as ProviderEvent & { kind: "usage" };
      expect(usage.inputTokens).toBe(5);
      expect(usage.outputTokens).toBe(7);
      expect(usage.cachedInputTokens).toBeUndefined();
      expect(usage.reasoningTokens).toBeUndefined();
      expect(usage.costUsd).toBeUndefined();
    });

    it("quota-style error frame emits non-recoverable error with source quota", () => {
      const provider = new PiProvider();
      const events = provider.parseFrame(
        encode({
          type: "error",
          category: "rate_limit_exceeded",
          message: "You have hit the rate limit. Try again later.",
        }),
      );
      expect(events).toEqual([
        {
          kind: "error",
          recoverable: false,
          source: "quota",
          message: "You have hit the rate limit. Try again later.",
        },
      ]);
    });

    it("quota keyword in message alone triggers quota source", () => {
      const provider = new PiProvider();
      const events = provider.parseFrame(
        encode({ type: "error", category: "billing", message: "monthly quota exceeded" }),
      );
      expect(events).toEqual([
        {
          kind: "error",
          recoverable: false,
          source: "quota",
          message: "monthly quota exceeded",
        },
      ]);
    });

    it("non-quota error frame emits non-recoverable error without quota source", () => {
      const provider = new PiProvider();
      const events = provider.parseFrame(
        encode({ type: "error", category: "internal", message: "boom" }),
      );
      expect(events).toEqual([{ kind: "error", recoverable: false, message: "boom" }]);
    });

    it("empty line returns empty array", () => {
      const provider = new PiProvider();
      expect(provider.parseFrame("")).toEqual([]);
      expect(provider.parseFrame("   ")).toEqual([]);
    });

    it("partial / non-JSON line returns empty array, does not throw", () => {
      const provider = new PiProvider();
      expect(provider.parseFrame("{not valid")).toEqual([]);
      expect(provider.parseFrame("plain stderr noise")).toEqual([]);
      expect(provider.parseFrame("Warning: heading...")).toEqual([]);
    });

    it("JSON without type field returns empty array", () => {
      const provider = new PiProvider();
      expect(provider.parseFrame(encode({ id: "no-type", data: 1 }))).toEqual([]);
    });

    it("unknown type produces non-recoverable error mentioning the type string", () => {
      const provider = new PiProvider();
      const events = provider.parseFrame(encode({ type: "future_event", payload: {} }));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "error", recoverable: false });
      expect((events[0] as ProviderEvent & { kind: "error" }).message).toContain("future_event");
    });

    it("queue_update / compaction_start / compaction_end / tool_execution_update / agent_start / message_start return empty array", () => {
      const provider = new PiProvider();
      expect(provider.parseFrame(encode({ type: "queue_update", queue: [] }))).toEqual([]);
      expect(provider.parseFrame(encode({ type: "compaction_start" }))).toEqual([]);
      expect(provider.parseFrame(encode({ type: "compaction_end" }))).toEqual([]);
      expect(provider.parseFrame(encode({ type: "tool_execution_update", tool_call_id: "tc-1" }))).toEqual([]);
      expect(provider.parseFrame(encode({ type: "agent_start" }))).toEqual([]);
      expect(provider.parseFrame(encode({ type: "message_start" }))).toEqual([]);
    });
  });
});
