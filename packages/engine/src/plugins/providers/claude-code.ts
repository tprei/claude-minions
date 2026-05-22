import { spawn } from "node:child_process";
import type {
  ProviderCapabilities,
  ProviderEvent,
  ProviderInvocation,
  ProviderPlugin,
  ProviderPrepareSpec,
  ProviderResumeSpec,
} from "../provider-plugin.js";

function toolResultTextSegments(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  return content.flatMap((block) => {
    if (typeof block !== "object" || block === null) return [];
    const record = block as Record<string, unknown>;
    return record["type"] === "text" && typeof record["text"] === "string" ? [record["text"]] : [];
  });
}

function hasStreamIdleTimeout(content: unknown): boolean {
  return toolResultTextSegments(content).some((text) => /^\s*API Error:\s*Stream idle timeout\b/i.test(text));
}

function isStreamIdleTimeoutResult(json: Record<string, unknown>): boolean {
  return typeof json["result"] === "string" && /^\s*API Error:\s*Stream idle timeout\b/i.test(json["result"]);
}

function isSocketConnectionClosedResult(json: Record<string, unknown>): boolean {
  return typeof json["result"] === "string" && /\bAPI Error:\s*The socket connection was closed unexpectedly\b/i.test(json["result"]);
}

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

  static readonly COMMIT_PREAMBLE = `You are running inside a git worktree.

If your task modifies files (code change, doc update, refactor, etc.):
  1. Run \`git add -A\` to stage every change you made.
  2. Commit: \`git -c user.email=minions@local -c user.name=minions commit -m "<short summary>"\`
  3. Verify with \`git log --oneline -3\`.
  Do not exit before committing the changes.

If your task is purely investigatory — analysis, audit, design, planning, research, code-reading — and produces no file changes:
  - Do NOT invent throwaway files just to have something to commit. That pollutes the repo.
  - Your findings ARE the deliverable. Present them in your final assistant message.
  - Skip git add / git commit. Exit cleanly.

USER TASK:
`;

  static readonly THINK_PREAMBLE = `You are operating in THINK mode — a strictly read-only research session. Your job is to think deeply and research the codebase and any relevant external sources as much as needed before answering the user's question. You are not making changes.

Rules:
- DO read files, grep, glob, and search the web — gather as much context as you need.
- DO reason carefully, weigh trade-offs, and produce a thorough, well-supported answer.
- You MAY dispatch read-only sub-agents (the Agent/Task tool) for parallel research.
- DO NOT edit, write, or create files. DO NOT run shell commands. DO NOT modify the repository or any system state.
- There is no commit step. Your final assistant message IS the deliverable.

USER QUESTION:
`;

  static readonly THINK_ALLOWED_TOOLS = "Read,Grep,Glob,WebSearch,WebFetch,NotebookRead,TodoWrite,Task";
  static readonly THINK_DISALLOWED_TOOLS = "Edit,Write,NotebookEdit,Bash";

  async prepare(spec: ProviderPrepareSpec): Promise<ProviderInvocation> {
    if (spec.prompt.trim() === "") throw new Error("prompt must be non-empty");
    if (spec.workflowKind === "think-thread") {
      const wrapped = `${ClaudeCodeProvider.THINK_PREAMBLE}${spec.prompt}`;
      return {
        command: [
          "claude", "-p", wrapped,
          "--output-format", "stream-json", "--verbose",
          "--allowedTools", ClaudeCodeProvider.THINK_ALLOWED_TOOLS,
          "--disallowedTools", ClaudeCodeProvider.THINK_DISALLOWED_TOOLS,
        ],
        providerType: "claude-code",
      };
    }
    const wrapped = `${ClaudeCodeProvider.COMMIT_PREAMBLE}${spec.prompt}`;
    return {
      command: ["claude", "-p", wrapped, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
      providerType: "claude-code",
    };
  }

  async resume(spec: ProviderResumeSpec): Promise<ProviderInvocation> {
    if (spec.prompt.trim() === "") throw new Error("prompt must be non-empty");
    if (spec.workflowKind === "think-thread") {
      return {
        command: [
          "claude", "-p", spec.prompt,
          "--resume", spec.sessionRef,
          "--output-format", "stream-json", "--verbose",
          "--allowedTools", ClaudeCodeProvider.THINK_ALLOWED_TOOLS,
          "--disallowedTools", ClaudeCodeProvider.THINK_DISALLOWED_TOOLS,
        ],
        providerType: "claude-code",
      };
    }
    return {
      command: ["claude", "-p", spec.prompt, "--resume", spec.sessionRef, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
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
              isError: b["is_error"] === true || hasStreamIdleTimeout(b["content"]),
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
          const streamIdleTimeout = isStreamIdleTimeoutResult(json);
          const socketConnectionClosed = isSocketConnectionClosedResult(json);
          const transientApiError = streamIdleTimeout || socketConnectionClosed;
          events.push({
            kind: "error",
            recoverable: transientApiError,
            ...(streamIdleTimeout
              ? { source: "stream_idle_timeout" }
              : socketConnectionClosed
                ? { source: "socket_connection_closed" }
                : {}),
            message: subtype !== "success"
              ? `unmapped result subtype: ${String(subtype ?? "unknown")}`
              : transientApiError
                ? String(json["result"])
                : `result is_error=true with subtype: ${String(subtype ?? "unknown")}${
                    typeof json["result"] === "string" && json["result"].trim().length > 0 ? `: ${json["result"]}` : ""
                  }`,
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
