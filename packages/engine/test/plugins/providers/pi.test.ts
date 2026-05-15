import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { PiProvider } from "../../../src/plugins/providers/pi.js";
import type { ProviderEvent } from "../../../src/plugins/provider-plugin.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

function encode(obj: unknown): string {
  return JSON.stringify(obj);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PiProvider", () => {
  describe("prepare", () => {
    it("returns normal-mode argv in the documented order", async () => {
      const provider = new PiProvider({
        agentDir: "/agents/coding",
        sessionDir: "/sessions/pi",
      });

      const inv = await provider.prepare({
        taskId: "t1",
        workflowId: "wf1",
        prompt: "fix the bug",
        dependencyArtifacts: [],
      });

      expect(inv.providerType).toBe("pi");
      const cmd = inv.command;
      expect(cmd[0]).toBe("pi");
      expect(cmd.slice(1, 4)).toEqual(["--mode", "json", "-p"]);
      expect(cmd.slice(4, 6)).toEqual(["--provider", "openai-codex"]);
      expect(cmd.slice(6, 8)).toEqual(["--model", PiProvider.DEFAULT_MODEL]);
      expect(cmd.slice(8, 10)).toEqual(["--thinking", PiProvider.DEFAULT_REASONING]);
      expect(cmd[10]).toBe("--no-context-files");
      expect(cmd.slice(11, 13)).toEqual(["--tools", PiProvider.DEFAULT_TOOLS]);
      expect(cmd.slice(13, 15)).toEqual(["--session-dir", "/sessions/pi"]);

      const finalArg = cmd[cmd.length - 1]!;
      expect(finalArg.startsWith(PiProvider.COMMIT_PREAMBLE)).toBe(true);
      expect(finalArg.endsWith("fix the bug")).toBe(true);
      expect(cmd).toHaveLength(16);
    });

    it("think-thread swaps preamble to THINK and restricts tools", async () => {
      const provider = new PiProvider({
        agentDir: "/agents/coding",
        sessionDir: "/sessions/pi",
      });

      const inv = await provider.prepare({
        taskId: "t1",
        workflowId: "wf1",
        prompt: "why does feature X exist",
        dependencyArtifacts: [],
        workflowKind: "think-thread",
      });

      const cmd = inv.command;
      const toolsIdx = cmd.indexOf("--tools");
      expect(toolsIdx).toBeGreaterThan(-1);
      const tools = new Set(cmd[toolsIdx + 1]!.split(","));
      expect(tools.has("read")).toBe(true);
      expect(tools.has("grep")).toBe(true);
      expect(tools.has("find")).toBe(true);
      expect(tools.has("ls")).toBe(true);
      expect(tools.has("write")).toBe(false);
      expect(tools.has("edit")).toBe(false);
      expect(tools.has("bash")).toBe(false);

      const finalArg = cmd[cmd.length - 1]!;
      expect(finalArg.startsWith(PiProvider.THINK_PREAMBLE)).toBe(true);
      expect(finalArg).toContain("why does feature X exist");
      expect(finalArg).not.toContain("git add -A");
    });

    it("env block contains PI_CODING_AGENT_DIR, PI_OFFLINE, PI_SKIP_VERSION_CHECK", async () => {
      const provider = new PiProvider({
        agentDir: "/agents/coding",
        sessionDir: "/sessions/pi",
      });

      const inv = await provider.prepare({
        taskId: "t1",
        workflowId: "wf1",
        prompt: "do work",
        dependencyArtifacts: [],
      });

      expect(inv.env).toEqual({
        PI_CODING_AGENT_DIR: "/agents/coding",
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      });
    });

    it("never injects --api-key", async () => {
      const provider = new PiProvider({ agentDir: "/a", sessionDir: "/s" });
      const inv = await provider.prepare({
        taskId: "t1",
        workflowId: "wf1",
        prompt: "do work",
        dependencyArtifacts: [],
      });
      expect(inv.command).not.toContain("--api-key");
    });

    describe("OPENAI_API_KEY passthrough gate", () => {
      const savedPassthrough = process.env["MWF_PI_API_KEY_PASSTHROUGH"];
      const savedKey = process.env["OPENAI_API_KEY"];

      afterEach(() => {
        if (savedPassthrough === undefined) delete process.env["MWF_PI_API_KEY_PASSTHROUGH"];
        else process.env["MWF_PI_API_KEY_PASSTHROUGH"] = savedPassthrough;
        if (savedKey === undefined) delete process.env["OPENAI_API_KEY"];
        else process.env["OPENAI_API_KEY"] = savedKey;
      });

      it("does not forward OPENAI_API_KEY when MWF_PI_API_KEY_PASSTHROUGH is unset", async () => {
        delete process.env["MWF_PI_API_KEY_PASSTHROUGH"];
        process.env["OPENAI_API_KEY"] = "sk-leak";

        const provider = new PiProvider({ agentDir: "/a", sessionDir: "/s" });
        const inv = await provider.prepare({
          taskId: "t1",
          workflowId: "wf1",
          prompt: "do work",
          dependencyArtifacts: [],
        });

        expect(inv.env).not.toHaveProperty("OPENAI_API_KEY");
      });

      it("forwards OPENAI_API_KEY only when MWF_PI_API_KEY_PASSTHROUGH=1", async () => {
        process.env["MWF_PI_API_KEY_PASSTHROUGH"] = "1";
        process.env["OPENAI_API_KEY"] = "sk-passthrough";

        const provider = new PiProvider({ agentDir: "/a", sessionDir: "/s" });
        const inv = await provider.prepare({
          taskId: "t1",
          workflowId: "wf1",
          prompt: "do work",
          dependencyArtifacts: [],
        });

        expect(inv.env?.["OPENAI_API_KEY"]).toBe("sk-passthrough");
      });

      it("does not forward OPENAI_API_KEY when MWF_PI_API_KEY_PASSTHROUGH has any other value", async () => {
        process.env["MWF_PI_API_KEY_PASSTHROUGH"] = "true";
        process.env["OPENAI_API_KEY"] = "sk-leak";

        const provider = new PiProvider({ agentDir: "/a", sessionDir: "/s" });
        const inv = await provider.prepare({
          taskId: "t1",
          workflowId: "wf1",
          prompt: "do work",
          dependencyArtifacts: [],
        });

        expect(inv.env).not.toHaveProperty("OPENAI_API_KEY");
      });
    });

    it("custom config overrides propagate", async () => {
      const provider = new PiProvider({
        model: "openai-codex/o1-preview",
        reasoning: "low",
        agentDir: "/custom/agent",
        sessionDir: "/custom/sessions",
        toolsAllowlist: "read,grep",
      });

      const inv = await provider.prepare({
        taskId: "t1",
        workflowId: "wf1",
        prompt: "go",
        dependencyArtifacts: [],
      });

      const cmd = inv.command;
      expect(cmd[cmd.indexOf("--model") + 1]).toBe("openai-codex/o1-preview");
      expect(cmd[cmd.indexOf("--thinking") + 1]).toBe("low");
      expect(cmd[cmd.indexOf("--tools") + 1]).toBe("read,grep");
      expect(cmd[cmd.indexOf("--session-dir") + 1]).toBe("/custom/sessions");
      expect(inv.env?.["PI_CODING_AGENT_DIR"]).toBe("/custom/agent");
    });

    it("throws on empty prompt", async () => {
      const provider = new PiProvider();
      await expect(
        provider.prepare({ taskId: "t1", workflowId: "wf1", prompt: "", dependencyArtifacts: [] }),
      ).rejects.toThrow("prompt must be non-empty");
    });

    it("throws on whitespace-only prompt", async () => {
      const provider = new PiProvider();
      await expect(
        provider.prepare({ taskId: "t1", workflowId: "wf1", prompt: "   \t\n", dependencyArtifacts: [] }),
      ).rejects.toThrow("prompt must be non-empty");
    });
  });

  describe("resume", () => {
    it("inserts --session and preserves model/reasoning/tools/session-dir args and the preamble from prepare", async () => {
      const provider = new PiProvider({
        agentDir: "/agents/coding",
        sessionDir: "/sessions/pi",
      });

      const prep = await provider.prepare({
        taskId: "t1",
        workflowId: "wf1",
        prompt: "first turn",
        dependencyArtifacts: [],
      });
      const res = await provider.resume({
        taskId: "t1",
        workflowId: "wf1",
        sessionRef: "sess-abc",
        prompt: "second turn",
      });

      expect(res.providerType).toBe("pi");
      expect(res.command).toContain("--session");
      const sessionIdx = res.command.indexOf("--session");
      expect(res.command[sessionIdx + 1]).toBe("sess-abc");

      const sharedFlags = ["--mode", "json", "-p", "--provider", "openai-codex", "--no-context-files"];
      for (const flag of sharedFlags) {
        expect(res.command).toContain(flag);
      }
      expect(res.command[res.command.indexOf("--model") + 1]).toBe(prep.command[prep.command.indexOf("--model") + 1]);
      expect(res.command[res.command.indexOf("--thinking") + 1]).toBe(prep.command[prep.command.indexOf("--thinking") + 1]);
      expect(res.command[res.command.indexOf("--tools") + 1]).toBe(prep.command[prep.command.indexOf("--tools") + 1]);
      expect(res.command[res.command.indexOf("--session-dir") + 1]).toBe(prep.command[prep.command.indexOf("--session-dir") + 1]);

      const finalArg = res.command[res.command.length - 1]!;
      expect(finalArg.startsWith(PiProvider.COMMIT_PREAMBLE)).toBe(true);
      expect(finalArg.endsWith("second turn")).toBe(true);

      expect(res.env).toEqual(prep.env);
    });

    it("think-thread resume uses THINK preamble and restricted tools", async () => {
      const provider = new PiProvider({ agentDir: "/a", sessionDir: "/s" });
      const res = await provider.resume({
        taskId: "t1",
        workflowId: "wf1",
        sessionRef: "sess-xyz",
        prompt: "follow up",
        workflowKind: "think-thread",
      });

      expect(res.command[res.command.indexOf("--tools") + 1]).toBe(PiProvider.THINK_ALLOWED_TOOLS);
      const finalArg = res.command[res.command.length - 1]!;
      expect(finalArg.startsWith(PiProvider.THINK_PREAMBLE)).toBe(true);
      expect(finalArg.endsWith("follow up")).toBe(true);
    });

    it("throws on empty prompt", async () => {
      const provider = new PiProvider();
      await expect(
        provider.resume({ taskId: "t1", workflowId: "wf1", sessionRef: "s", prompt: "" }),
      ).rejects.toThrow("prompt must be non-empty");
    });

    it("throws on whitespace-only prompt", async () => {
      const provider = new PiProvider();
      await expect(
        provider.resume({ taskId: "t1", workflowId: "wf1", sessionRef: "s", prompt: "  " }),
      ).rejects.toThrow("prompt must be non-empty");
    });
  });

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

  describe("loginStatus", () => {
    it("missing file returns loggedIn false with no auth.json details", async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(
        Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }),
      );

      const provider = new PiProvider({ agentDir: "/agents/coding" });
      const result = await provider.loginStatus();

      expect(result).toEqual({ loggedIn: false, details: "no auth.json" });
      expect(vi.mocked(fsp.readFile)).toHaveBeenCalledWith(
        join("/agents/coding", "auth.json"),
        "utf8",
      );
    });

    it("parse error returns loggedIn false without leaking raw token content", async () => {
      vi.mocked(fsp.readFile).mockResolvedValue("{ this is not valid json secret-token-xyz");

      const provider = new PiProvider({ agentDir: "/agents/coding" });
      const result = await provider.loginStatus();

      expect(result).toEqual({ loggedIn: false, details: "auth.json parse error" });
      expect(result.details).not.toContain("secret-token-xyz");
    });

    it("valid file with Codex oauth subscription entry returns loggedIn true", async () => {
      const auth = {
        "openai-codex": {
          type: "oauth",
          access_token: "sk-super-secret-token-must-not-leak",
          refresh_token: "rt-super-secret",
        },
      };
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(auth));

      const provider = new PiProvider({ agentDir: "/agents/coding" });
      const result = await provider.loginStatus();

      expect(result).toEqual({ loggedIn: true, details: "chatgpt-codex" });
      expect(result.details).not.toContain("sk-super-secret-token-must-not-leak");
    });

    it("valid file with Codex subscription entry returns loggedIn true", async () => {
      const auth = {
        "openai-codex": {
          type: "subscription",
        },
      };
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(auth));

      const provider = new PiProvider({ agentDir: "/agents/coding" });
      await expect(provider.loginStatus()).resolves.toEqual({
        loggedIn: true,
        details: "chatgpt-codex",
      });
    });

    it("valid file without Codex entry returns loggedIn false", async () => {
      const auth = {
        "anthropic-claude": { type: "oauth", access_token: "x" },
      };
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(auth));

      const provider = new PiProvider({ agentDir: "/agents/coding" });
      const result = await provider.loginStatus();

      expect(result).toEqual({ loggedIn: false, details: "no codex subscription" });
    });
  });
});
