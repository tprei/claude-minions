import { spawn } from "node:child_process";
import type {
  ProviderCapabilities,
  ProviderEvent,
  ProviderInvocation,
  ProviderPlugin,
  ProviderPrepareSpec,
  ProviderResumeSpec,
} from "../provider-plugin.js";

export class ClaudeCodeProvider implements ProviderPlugin {
  readonly name = "claude-code";

  readonly capabilities: ProviderCapabilities = {
    resume: true,
    mcp: true,
    structuredOutput: false,
    oauthLogin: true,
    streamJson: true,
    sessionRefFormat: "uuid",
  };

  async prepare(spec: ProviderPrepareSpec): Promise<ProviderInvocation> {
    if (spec.prompt.trim() === "") throw new Error("prompt must be non-empty");
    return {
      command: ["claude", "-p", spec.prompt, "--output-format", "stream-json", "--verbose"],
      providerType: "claude-code",
    };
  }

  async resume(spec: ProviderResumeSpec): Promise<ProviderInvocation> {
    if (spec.prompt.trim() === "") throw new Error("prompt must be non-empty");
    return {
      command: ["claude", "-p", spec.prompt, "--resume", spec.sessionRef, "--output-format", "stream-json", "--verbose"],
      providerType: "claude-code",
    };
  }

  // Two distinct failure modes:
  // - Empty/whitespace OR non-JSON line → [] (silently dropped — stderr noise from merged stream)
  // - JSON parses but type/shape is unrecognized → [error{...}] (loud — schema gap to investigate)
  parseFrame(line: string): ProviderEvent[] {
    if (line.trim().length === 0) return [];

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }

    const type = json["type"];

    switch (type) {
      case "system": {
        if (json["subtype"] === "api_retry") {
          return [
            {
              kind: "error",
              recoverable: true,
              source: "api_retry",
              message: typeof json["message"] === "string" ? json["message"] : "api_retry",
            },
          ];
        }
        return [];
      }

      case "assistant": {
        const message = json["message"] as Record<string, unknown> | undefined;
        const content = Array.isArray(message?.["content"]) ? (message["content"] as unknown[]) : [];
        const events: ProviderEvent[] = [];
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b["type"] === "text") {
            events.push({ kind: "assistant_text", text: String(b["text"] ?? "") });
          } else if (b["type"] === "thinking") {
            events.push({ kind: "thinking", text: String(b["thinking"] ?? "") });
          } else if (b["type"] === "tool_use") {
            events.push({
              kind: "tool_call",
              id: String(b["id"] ?? ""),
              name: String(b["name"] ?? ""),
              input: b["input"],
            });
          }
        }
        return events;
      }

      case "user": {
        const userMsg = json["message"] as Record<string, unknown> | undefined;
        const content = Array.isArray(userMsg?.["content"]) ? (userMsg["content"] as unknown[]) : [];
        const events: ProviderEvent[] = [];
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b["type"] === "tool_result") {
            events.push({
              kind: "tool_result",
              id: String(b["tool_use_id"] ?? ""),
              output: b["content"],
              isError: b["is_error"] === true,
            });
          }
        }
        return events;
      }

      case "result": {
        const subtype = json["subtype"] as string | undefined;
        const usage = json["usage"] as Record<string, unknown> | undefined;
        const sessionId = json["session_id"];

        const events: ProviderEvent[] = [];

        const errored = subtype !== "success" || json["is_error"] === true;
        if (errored) {
          events.push({
            kind: "error",
            recoverable: false,
            message: subtype !== "success"
              ? `unmapped result subtype: ${String(subtype ?? "unknown")}`
              : `result is_error=true with subtype: ${String(subtype ?? "unknown")}`,
          });
        }

        events.push({
          kind: "usage",
          inputTokens: typeof usage?.["input_tokens"] === "number" ? usage["input_tokens"] : 0,
          outputTokens: typeof usage?.["output_tokens"] === "number" ? usage["output_tokens"] : 0,
          ...(typeof usage?.["cache_read_input_tokens"] === "number"
            ? { cachedInputTokens: usage["cache_read_input_tokens"] }
            : {}),
          ...(typeof json["total_cost_usd"] === "number" ? { costUsd: json["total_cost_usd"] } : {}),
        });

        events.push({
          kind: "final",
          sessionRef: typeof sessionId === "string" ? sessionId : "",
          exitMetadata: {
            subtype,
            ...(typeof json["duration_ms"] === "number" ? { duration_ms: json["duration_ms"] } : {}),
            ...(typeof json["num_turns"] === "number" ? { numTurns: json["num_turns"] } : {}),
          },
        });

        return events;
      }

      case "stream_event": {
        return [];
      }

      case "rate_limit_event": {
        return [];
      }

      default: {
        return [
          {
            kind: "error",
            recoverable: false,
            message: `unmapped claude type: ${String(type ?? "undefined")}`,
          },
        ];
      }
    }
  }

  loginStatus(): Promise<{ loggedIn: boolean; details?: string }> {
    return new Promise((resolve) => {
      const child = spawn("claude", ["auth", "status"]);
      child.on("close", (code: number | null) => {
        resolve({ loggedIn: code === 0 });
      });
      child.on("error", () => {
        resolve({ loggedIn: false });
      });
    });
  }
}
