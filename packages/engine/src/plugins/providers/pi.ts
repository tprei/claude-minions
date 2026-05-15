import type {
  ProviderCapabilities,
  ProviderEvent,
  ProviderInvocation,
  ProviderPlugin,
  ProviderPrepareSpec,
  ProviderResumeSpec,
} from "../provider-plugin.js";

export interface PiProviderConfig {
  model?: string;
  reasoning?: string;
  agentDir?: string;
  sessionDir?: string;
  toolsAllowlist?: string;
}

const QUOTA_PATTERN = /quota/i;
const RATE_PATTERN = /rate/i;
const LIMIT_PATTERN = /limit/i;

function isQuotaSignature(...values: Array<unknown>): boolean {
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (QUOTA_PATTERN.test(value)) return true;
    if (RATE_PATTERN.test(value) && LIMIT_PATTERN.test(value)) return true;
  }
  return false;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export class PiProvider implements ProviderPlugin {
  readonly name = "pi";

  readonly capabilities: ProviderCapabilities = {
    resume: true,
    mcp: false,
    structuredOutput: false,
    oauthLogin: true,
    streamJson: true,
    sessionRefFormat: "uuid",
  };

  static readonly DEFAULT_MODEL = "openai-codex/gpt-5.5";
  static readonly DEFAULT_REASONING = "xhigh";
  static readonly DEFAULT_AGENT_DIR = "/workspace";
  static readonly DEFAULT_SESSION_DIR = "/workspace/.pi-sessions";
  static readonly DEFAULT_TOOLS = "read,write,edit,bash,grep,find,ls";
  static readonly THINK_ALLOWED_TOOLS = "read,grep,find,ls";

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

  readonly model: string;
  readonly reasoning: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly toolsAllowlist: string;

  // This state ties one provider instance to one conversation; the engine MUST construct a fresh instance per run.
  lastSessionId: string | null = null;

  constructor(config: PiProviderConfig = {}) {
    this.model = config.model ?? PiProvider.DEFAULT_MODEL;
    this.reasoning = config.reasoning ?? PiProvider.DEFAULT_REASONING;
    this.agentDir = config.agentDir ?? PiProvider.DEFAULT_AGENT_DIR;
    this.sessionDir = config.sessionDir ?? PiProvider.DEFAULT_SESSION_DIR;
    this.toolsAllowlist = config.toolsAllowlist ?? PiProvider.DEFAULT_TOOLS;
  }

  async prepare(spec: ProviderPrepareSpec): Promise<ProviderInvocation> {
    if (spec.prompt.trim() === "") throw new Error("prompt must be non-empty");
    const isThink = spec.workflowKind === "think-thread";
    const preamble = isThink ? PiProvider.THINK_PREAMBLE : PiProvider.COMMIT_PREAMBLE;
    const tools = isThink ? PiProvider.THINK_ALLOWED_TOOLS : this.toolsAllowlist;

    return {
      command: [
        "pi",
        "--mode",
        "json",
        "-p",
        "--provider",
        "openai-codex",
        "--model",
        this.model,
        "--thinking",
        this.reasoning,
        "--no-context-files",
        "--tools",
        tools,
        "--session-dir",
        this.sessionDir,
        `${preamble}${spec.prompt}`,
      ],
      env: this.buildEnv(),
      providerType: "pi",
    };
  }

  async resume(spec: ProviderResumeSpec): Promise<ProviderInvocation> {
    if (spec.prompt.trim() === "") throw new Error("prompt must be non-empty");
    const isThink = spec.workflowKind === "think-thread";
    const preamble = isThink ? PiProvider.THINK_PREAMBLE : PiProvider.COMMIT_PREAMBLE;
    const tools = isThink ? PiProvider.THINK_ALLOWED_TOOLS : this.toolsAllowlist;

    return {
      command: [
        "pi",
        "--mode",
        "json",
        "-p",
        "--provider",
        "openai-codex",
        "--model",
        this.model,
        "--thinking",
        this.reasoning,
        "--no-context-files",
        "--tools",
        tools,
        "--session-dir",
        this.sessionDir,
        "--session",
        spec.sessionRef,
        `${preamble}${spec.prompt}`,
      ],
      env: this.buildEnv(),
      providerType: "pi",
    };
  }

  parseFrame(line: string): ProviderEvent[] {
    if (line.trim().length === 0) return [];

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }

    const type = json["type"];
    if (typeof type !== "string") return [];

    switch (type) {
      case "session": {
        if (this.lastSessionId !== null) {
          throw new Error("PiProvider instance reused across conversations; construct a fresh instance per run");
        }
        const id = json["id"];
        this.lastSessionId = typeof id === "string" ? id : null;
        return [];
      }

      case "agent_start":
      case "turn_start":
      case "message_start":
      case "queue_update":
      case "compaction_start":
      case "compaction_end":
      case "tool_execution_update":
      case "turn_end":
        return [];

      case "message_update":
      case "message_end": {
        const block = json["content_block"] as Record<string, unknown> | undefined;
        const blockType = block?.["type"];
        const text = readString(block?.["text"], "");
        if (blockType === "text") return [{ kind: "assistant_text", text }];
        if (blockType === "thinking") return [{ kind: "thinking", text }];
        return [];
      }

      case "tool_execution_start": {
        return [
          {
            kind: "tool_call",
            id: readString(json["tool_call_id"], ""),
            name: readString(json["tool_name"], ""),
            input: json["args"] ?? null,
          },
        ];
      }

      case "tool_execution_end": {
        return [
          {
            kind: "tool_result",
            id: readString(json["tool_call_id"], ""),
            output: json["result"] ?? null,
            isError: json["is_error"] === true,
          },
        ];
      }

      case "auto_retry_start": {
        return [
          {
            kind: "error",
            recoverable: true,
            source: "auto_retry",
            message: readString(json["message"], "auto retry"),
          },
        ];
      }

      case "auto_retry_end": {
        if (json["success"] === false) {
          return [
            {
              kind: "error",
              recoverable: true,
              source: "auto_retry_end",
              message: readString(json["message"], "auto retry failed"),
            },
          ];
        }
        return [];
      }

      case "agent_end": {
        const usage = json["usage"] as Record<string, unknown> | undefined;
        const exitMetadata: Record<string, unknown> = {};
        if (typeof json["exit_code"] === "number") exitMetadata["exit_code"] = json["exit_code"];
        if (typeof json["reason"] === "string") exitMetadata["reason"] = json["reason"];
        return [
          {
            kind: "usage",
            inputTokens: typeof usage?.["input_tokens"] === "number" ? usage["input_tokens"] : 0,
            outputTokens: typeof usage?.["output_tokens"] === "number" ? usage["output_tokens"] : 0,
            ...(typeof usage?.["cached_input_tokens"] === "number"
              ? { cachedInputTokens: usage["cached_input_tokens"] }
              : {}),
            ...(typeof usage?.["reasoning_tokens"] === "number"
              ? { reasoningTokens: usage["reasoning_tokens"] }
              : {}),
            ...(typeof usage?.["cost_usd"] === "number" ? { costUsd: usage["cost_usd"] } : {}),
          },
          {
            kind: "final",
            sessionRef: this.lastSessionId ?? "",
            exitMetadata,
          },
        ];
      }

      case "error": {
        const category = json["category"];
        const message = readString(json["message"], "pi error");
        if (isQuotaSignature(category, message)) {
          return [{ kind: "error", recoverable: false, source: "quota", message }];
        }
        return [{ kind: "error", recoverable: false, message }];
      }

      default: {
        return [
          {
            kind: "error",
            recoverable: false,
            message: `unmapped pi type: ${type}`,
          },
        ];
      }
    }
  }

  loginStatus(): Promise<{ loggedIn: boolean; details?: string }> {
    return Promise.resolve({ loggedIn: false });
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {
      PI_CODING_AGENT_DIR: this.agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    };
    if (process.env["MWF_PI_API_KEY_PASSTHROUGH"] === "1") {
      const key = process.env["OPENAI_API_KEY"];
      if (typeof key === "string" && key.length > 0) {
        env["OPENAI_API_KEY"] = key;
      }
    }
    return env;
  }
}
