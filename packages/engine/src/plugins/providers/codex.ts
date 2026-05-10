import { spawn } from "node:child_process";
import type {
  ProviderCapabilities,
  ProviderEvent,
  ProviderInvocation,
  ProviderPlugin,
  ProviderPrepareSpec,
  ProviderResumeSpec,
} from "../provider-plugin.js";

export class CodexProvider implements ProviderPlugin {
  readonly name = "codex";

  readonly capabilities: ProviderCapabilities = {
    resume: true,
    mcp: true,
    structuredOutput: false,
    oauthLogin: true,
    streamJson: true,
    sessionRefFormat: "opaque",
  };

  // This state ties one provider instance to one conversation; the engine MUST construct a fresh instance per run.
  private lastThreadId: string | undefined;

  async prepare(spec: ProviderPrepareSpec): Promise<ProviderInvocation> {
    if (spec.prompt.trim() === "") throw new Error("prompt must be non-empty");
    return {
      command: ["codex", "exec", "--json", spec.prompt],
      providerType: "codex",
    };
  }

  async resume(spec: ProviderResumeSpec): Promise<ProviderInvocation> {
    if (spec.prompt.trim() === "") throw new Error("prompt must be non-empty");
    return {
      command: ["codex", "exec", "resume", "--json", spec.sessionRef, spec.prompt],
      providerType: "codex",
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
      case "thread.started": {
        if (this.lastThreadId !== undefined) {
          throw new Error("CodexProvider instance reused across conversations; construct a fresh instance per run");
        }
        this.lastThreadId = typeof json["thread_id"] === "string" ? json["thread_id"] : undefined;
        return [];
      }

      case "turn.started": {
        return [];
      }

      case "turn.completed": {
        const usage = json["usage"] as Record<string, unknown> | undefined;
        return [
          {
            kind: "usage",
            inputTokens: typeof usage?.["input_tokens"] === "number" ? usage["input_tokens"] : 0,
            outputTokens: typeof usage?.["output_tokens"] === "number" ? usage["output_tokens"] : 0,
            ...(typeof usage?.["cached_input_tokens"] === "number"
              ? { cachedInputTokens: usage["cached_input_tokens"] }
              : {}),
            ...(typeof usage?.["reasoning_output_tokens"] === "number"
              ? { reasoningTokens: usage["reasoning_output_tokens"] }
              : {}),
          },
          {
            kind: "final",
            sessionRef: this.lastThreadId ?? "",
            exitMetadata: {
              ...(typeof json["turn_id"] === "string" ? { turn_id: json["turn_id"] } : {}),
            },
          },
        ];
      }

      case "turn.failed": {
        const error = json["error"] as Record<string, unknown> | undefined;
        return [
          {
            kind: "error",
            recoverable: false,
            message: typeof error?.["message"] === "string" ? error["message"] : "turn failed",
          },
          {
            kind: "final",
            sessionRef: this.lastThreadId ?? "",
            exitMetadata: { failed: true },
          },
        ];
      }

      case "item.started": {
        const item = json["item"] as Record<string, unknown> | undefined;
        const itemType = item?.["type"] as string | undefined;
        if (item !== undefined && itemType !== undefined) {
          let toolInput: unknown = null;
          if (itemType === "command_execution") {
            toolInput = item["command"] ?? null;
          } else if (itemType === "mcp_tool_call") {
            toolInput = item["arguments"] ?? null;
          } else if (itemType === "web_search") {
            toolInput = { query: item["query"] ?? null };
          } else if (itemType === "file_change") {
            toolInput = { changes: item["changes"] ?? null };
          } else {
            return [];
          }
          const toolName =
            itemType === "mcp_tool_call" ? String(item["tool"] ?? "mcp_tool_call") : itemType;
          return [
            {
              kind: "tool_call",
              id: String(item["id"] ?? ""),
              name: toolName,
              input: toolInput,
            },
          ];
        }
        return [];
      }

      case "item.completed": {
        const item = json["item"] as Record<string, unknown> | undefined;
        const itemType = item?.["type"] as string | undefined;
        if (itemType === "agent_message") {
          return [{ kind: "assistant_text", text: String(item?.["text"] ?? "") }];
        }
        if (itemType === "reasoning") {
          return [{ kind: "thinking", text: String(item?.["text"] ?? "") }];
        }
        if (itemType === "command_execution") {
          const status = item?.["status"] as string | undefined;
          return [
            {
              kind: "tool_result",
              id: String(item?.["id"] ?? ""),
              output: item?.["aggregated_output"] ?? null,
              isError: status === "failed" || status === "declined",
            },
          ];
        }
        if (itemType === "mcp_tool_call") {
          const status = item?.["status"] as string | undefined;
          const isFailed = status === "failed";
          return [
            {
              kind: "tool_result",
              id: String(item?.["id"] ?? ""),
              output: isFailed ? (item?.["error"] ?? item?.["result"] ?? null) : (item?.["result"] ?? null),
              isError: isFailed,
            },
          ];
        }
        if (itemType === "file_change") {
          const status = item?.["status"] as string | undefined;
          return [
            {
              kind: "tool_result",
              id: String(item?.["id"] ?? ""),
              output: item?.["changes"] ?? null,
              isError: status === "failed",
            },
          ];
        }
        if (itemType === "web_search") {
          const status = item?.["status"] as string | undefined;
          return [
            {
              kind: "tool_result",
              id: String(item?.["id"] ?? ""),
              output: item?.["query"] ?? null,
              isError: status === "failed",
            },
          ];
        }
        if (itemType === "error") {
          return [
            {
              kind: "error",
              recoverable: true,
              message: typeof item?.["message"] === "string" ? item["message"] : "item error",
            },
          ];
        }
        return [];
      }

      case "item.updated": {
        return [];
      }

      case "error": {
        return [
          {
            kind: "error",
            recoverable: false,
            message: typeof json["message"] === "string" ? json["message"] : "codex error",
          },
        ];
      }

      default: {
        return [
          {
            kind: "error",
            recoverable: false,
            message: `unmapped codex type: ${String(type ?? "undefined")}`,
          },
        ];
      }
    }
  }

  loginStatus(): Promise<{ loggedIn: boolean; details?: string }> {
    return new Promise((resolve) => {
      const child = spawn("codex", ["login", "status"]);
      child.on("close", (code: number | null) => {
        resolve({ loggedIn: code === 0 });
      });
      child.on("error", () => {
        resolve({ loggedIn: false });
      });
    });
  }
}
