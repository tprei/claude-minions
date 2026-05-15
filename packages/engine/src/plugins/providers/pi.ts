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
  readonly agentDir: string | undefined;
  readonly sessionDir: string | undefined;
  readonly toolsAllowlist: string;

  // This state ties one provider instance to one conversation; the engine MUST construct a fresh instance per run.
  lastSessionId: string | null = null;

  constructor(config: PiProviderConfig = {}) {
    this.model = config.model ?? PiProvider.DEFAULT_MODEL;
    this.reasoning = config.reasoning ?? PiProvider.DEFAULT_REASONING;
    this.agentDir = config.agentDir;
    this.sessionDir = config.sessionDir;
    this.toolsAllowlist = config.toolsAllowlist ?? PiProvider.DEFAULT_TOOLS;
  }

  async prepare(spec: ProviderPrepareSpec): Promise<ProviderInvocation> {
    if (spec.prompt.trim() === "") throw new Error("prompt must be non-empty");
    throw new Error("PiProvider.prepare not implemented");
  }

  async resume(spec: ProviderResumeSpec): Promise<ProviderInvocation> {
    if (spec.prompt.trim() === "") throw new Error("prompt must be non-empty");
    throw new Error("PiProvider.resume not implemented");
  }

  parseFrame(_line: string): ProviderEvent[] {
    return [];
  }

  loginStatus(): Promise<{ loggedIn: boolean; details?: string }> {
    return Promise.resolve({ loggedIn: false });
  }
}
