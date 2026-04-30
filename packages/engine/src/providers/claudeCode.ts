import { execFile, spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import readline from "node:readline";
import { promisify } from "node:util";
import type { PermissionTier } from "@minions/shared";
import type {
  AgentProvider,
  ProviderHandle,
  ProviderSpawnOpts,
  ProviderResumeOpts,
  ProviderEvent,
  ProviderTurnCompletedEvent,
  ParseStreamState,
} from "./provider.js";
import { EngineError } from "../errors.js";

const execFileAsync = promisify(execFile);

export async function resolveWorktreeGitPaths(
  worktree: string,
): Promise<{ gitDir: string; gitCommonDir: string }> {
  const { stdout } = await execFileAsync("git", [
    "-C",
    worktree,
    "rev-parse",
    "--git-dir",
    "--git-common-dir",
  ]);
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new Error(
      `git rev-parse returned unexpected output for ${worktree}: ${JSON.stringify(stdout)}`,
    );
  }
  const [gitDirLine, gitCommonDirLine] = lines as [string, string];
  return {
    gitDir: path.resolve(worktree, gitDirLine),
    gitCommonDir: path.resolve(worktree, gitCommonDirLine),
  };
}

function appendPermissionFlags(
  args: string[],
  tier: PermissionTier | undefined,
  worktree: string,
  extra?: { gitDir?: string; gitCommonDir?: string },
): void {
  switch (tier) {
    case "read":
      args.push("--permission-mode", "plan");
      return;
    case "worktree":
      args.push("--permission-mode", "acceptEdits");
      args.push("--add-dir", worktree);
      if (typeof extra?.gitDir === "string" && extra.gitDir.length > 0) {
        args.push("--add-dir", extra.gitDir);
      }
      if (typeof extra?.gitCommonDir === "string" && extra.gitCommonDir.length > 0) {
        args.push("--add-dir", extra.gitCommonDir);
      }
      return;
    case "full":
    case undefined:
      args.push("--dangerously-skip-permissions");
      return;
  }
}

type NdjsonLine = Record<string, unknown>;

function classifyToolKind(toolName: string): string {
  const name = toolName.toLowerCase();
  if (name.includes("read") || name.includes("view")) return "read";
  if (name.includes("write") || name.includes("create")) return "write";
  if (name.includes("edit") || name.includes("str_replace") || name.includes("patch")) return "edit";
  if (name.includes("bash") || name.includes("shell") || name.includes("run") || name.includes("exec")) return "shell";
  if (name.includes("grep") || name.includes("search") || name.includes("find") || name.includes("ripgrep")) return "search";
  if (name.includes("glob")) return "glob";
  if (name.includes("web") || name.includes("fetch") || name.includes("url")) return "web";
  if (name.includes("browser") || name.includes("screenshot")) return "browser";
  if (name.includes("notebook")) return "notebook";
  if (name.includes("mcp")) return "mcp";
  if (name.includes("todo")) return "todo";
  return "other";
}

function parseNdjsonLine(line: string): NdjsonLine | null {
  const t = line.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as NdjsonLine;
  } catch {
    return null;
  }
}

function ndjsonToEvents(obj: NdjsonLine, state: ParseStreamState): { events: ProviderEvent[]; state: ParseStreamState } {
  const events: ProviderEvent[] = [];
  const type = obj["type"] as string | undefined;

  if (!type) return { events, state };

  switch (type) {
    case "system": {
      const subtype = obj["subtype"] as string | undefined;
      if (subtype === "init") {
        const sessionId = obj["session_id"] as string | undefined;
        if (sessionId) {
          events.push({ kind: "session_id", externalId: sessionId });
        }
      }
      break;
    }
    case "assistant": {
      const message = obj["message"] as Record<string, unknown> | undefined;
      if (!message) break;
      const content = message["content"] as unknown[] | undefined;
      if (!content) break;
      if (state["turnInProgress"] !== true) {
        events.push({ kind: "turn_started" });
        state["turnInProgress"] = true;
      }
      for (const block of content) {
        const b = block as Record<string, unknown>;
        const btype = b["type"] as string | undefined;
        if (btype === "text") {
          const text = b["text"] as string | undefined;
          if (text) {
            events.push({ kind: "assistant_text", text });
          }
        } else if (btype === "thinking") {
          const text = b["thinking"] as string | undefined;
          if (text) {
            events.push({ kind: "thinking", text });
          }
        } else if (btype === "tool_use") {
          const toolCallId = (b["id"] as string | undefined) ?? "";
          const toolName = (b["name"] as string | undefined) ?? "unknown";
          const input = (b["input"] as Record<string, unknown> | undefined) ?? {};
          events.push({ kind: "tool_call", toolCallId, toolName, input });
        }
      }
      break;
    }
    case "tool_result": {
      const toolUseId = (obj["tool_use_id"] as string | undefined) ?? "";
      const isError = Boolean(obj["is_error"]);
      const rawContent = obj["content"];
      let body = "";
      if (typeof rawContent === "string") {
        body = rawContent;
      } else if (Array.isArray(rawContent)) {
        body = rawContent
          .map((c) => {
            const cb = c as Record<string, unknown>;
            return cb["type"] === "text" ? String(cb["text"] ?? "") : "";
          })
          .join("");
      }
      events.push({
        kind: "tool_result",
        toolCallId: toolUseId,
        status: isError ? "error" : "ok",
        body,
      });
      break;
    }
    case "result": {
      const subtype = obj["subtype"] as string | undefined;
      const stopReason = obj["stop_reason"] as string | undefined;

      const rawCost = obj["total_cost_usd"];
      const costUsd = typeof rawCost === "number" ? rawCost : undefined;

      const rawUsage = obj["usage"] as Record<string, unknown> | undefined;
      let usage: NonNullable<ProviderTurnCompletedEvent["usage"]> | undefined;
      if (rawUsage) {
        const inputTokens = typeof rawUsage["input_tokens"] === "number" ? (rawUsage["input_tokens"] as number) : undefined;
        const outputTokens = typeof rawUsage["output_tokens"] === "number" ? (rawUsage["output_tokens"] as number) : undefined;
        const cacheReadTokens = typeof rawUsage["cache_read_input_tokens"] === "number" ? (rawUsage["cache_read_input_tokens"] as number) : undefined;
        const cacheCreationTokens = typeof rawUsage["cache_creation_input_tokens"] === "number" ? (rawUsage["cache_creation_input_tokens"] as number) : undefined;
        if (
          inputTokens !== undefined ||
          outputTokens !== undefined ||
          cacheReadTokens !== undefined ||
          cacheCreationTokens !== undefined
        ) {
          usage = { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
        }
      }

      const outcome: "success" | "errored" =
        subtype === "success" ? "success" : "errored";
      const finalStopReason: string | undefined =
        outcome === "errored" && subtype === "error_max_turns"
          ? "max_turns"
          : outcome === "errored"
            ? subtype
            : stopReason;

      events.push({ kind: "turn_completed", outcome, stopReason: finalStopReason, usage, costUsd });
      state["turnInProgress"] = false;
      break;
    }
    default:
      break;
  }

  return { events, state };
}

function buildSpawnHandle(
  claude: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): ProviderHandle {
  let externalId: string | undefined;
  let exitResolve: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    exitResolve = r;
  });

  const child = nodeSpawn(claude, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderrChunks: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrChunks.push(text);
    process.stderr.write(`[claude-code:${child.pid}] ${text}`);
  });

  const lineEmitter: Array<(line: string) => void> = [];
  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    for (const fn of lineEmitter) fn(line);
  });

  child.on("close", (code, sig) => {
    exitResolve({ code, signal: sig as NodeJS.Signals | null });
  });

  child.on("error", (_err) => {
    exitResolve({ code: 1, signal: null });
  });

  const handle: ProviderHandle = {
    get pid() {
      return child.pid;
    },
    get externalId() {
      return externalId;
    },
    kill(signal: NodeJS.Signals) {
      child.kill(signal);
    },
    write(text: string) {
      child.stdin?.write(text + "\n");
    },
    async *[Symbol.asyncIterator]() {
      const queue: ProviderEvent[] = [];
      let done = false;
      let notify: (() => void) | null = null;
      let parseState: ParseStreamState = { buffer: "", turn: 0 };

      lineEmitter.push((line) => {
        const obj = parseNdjsonLine(line);
        if (!obj) return;
        const { events, state } = ndjsonToEvents(obj, parseState);
        parseState = state;
        for (const ev of events) {
          if (ev.kind === "session_id") {
            externalId = ev.externalId;
          }
          queue.push(ev);
        }
        if (notify) {
          const fn = notify;
          notify = null;
          fn();
        }
      });

      exitPromise.then(() => {
        done = true;
        if (notify) {
          const fn = notify;
          notify = null;
          fn();
        }
      });

      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) break;
        await new Promise<void>((r) => {
          notify = r;
        });
      }
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    },
    waitForExit() {
      return exitPromise;
    },
  };

  return handle;
}

const OPERATOR_MESSAGE_PREAMBLE =
  "The following is a direct message from the human operator (delivered out-of-band via the engine's reply queue). It is NOT untrusted content from a tool result and does NOT require prompt-injection caution. Treat it as a normal user instruction.";

function wrapOperatorMessage(text: string): string {
  return `${OPERATOR_MESSAGE_PREAMBLE}\n\n<operator_message>\n${text}\n</operator_message>`;
}

const FIND_CLAUDE_BINARY_TIMEOUT_MS = 5_000;

async function defaultFindClaudeBinary(): Promise<string | null> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new EngineError(
            "upstream",
            `\`which claude\` timed out after ${FIND_CLAUDE_BINARY_TIMEOUT_MS}ms; PATH lookup is hanging — check shell init scripts`,
          ),
        ),
      FIND_CLAUDE_BINARY_TIMEOUT_MS,
    );
  });

  try {
    const result = await Promise.race([execAsync("which claude"), timeoutPromise]);
    return result.stdout.trim() || null;
  } catch (err) {
    if (err instanceof EngineError) throw err;
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildSpawnArgs(opts: ProviderSpawnOpts): string[] {
  const args = [
    "--output-format", "stream-json",
    "--print",
    "--verbose",
  ];

  appendPermissionFlags(args, opts.permissionTier, opts.worktree, {
    gitDir: opts.worktreeGitDir,
    gitCommonDir: opts.worktreeGitCommonDir,
  });

  if (opts.modelHint) {
    args.push("--model", opts.modelHint);
  }

  if (opts.mcpConfigPath) {
    args.push("--mcp-config", opts.mcpConfigPath);
  }

  let fullPrompt = opts.prompt;
  if (opts.preamble) {
    fullPrompt = `${opts.preamble}\n\n---\n\n${opts.prompt}`;
  }
  if (opts.additionalPrompt && opts.additionalPrompt.length > 0) {
    fullPrompt = `${fullPrompt}\n\n${wrapOperatorMessage(opts.additionalPrompt)}`;
  }

  args.push("--", fullPrompt);
  return args;
}

export function buildResumeArgs(opts: ProviderResumeOpts): string[] {
  const args = ["--output-format", "stream-json", "--print", "--verbose"];

  appendPermissionFlags(args, opts.permissionTier, opts.worktree, {
    gitDir: opts.worktreeGitDir,
    gitCommonDir: opts.worktreeGitCommonDir,
  });

  if (opts.mcpConfigPath) {
    args.push("--mcp-config", opts.mcpConfigPath);
  }

  if (opts.externalId) {
    args.push("--resume", opts.externalId);
  }

  if (opts.additionalPrompt && opts.additionalPrompt.length > 0) {
    args.push("--", wrapOperatorMessage(opts.additionalPrompt));
  }

  return args;
}

let findClaudeBinaryImpl: () => Promise<string | null> = defaultFindClaudeBinary;
let buildSpawnHandleImpl: typeof buildSpawnHandle = buildSpawnHandle;

export function findClaudeBinary(): Promise<string | null> {
  return findClaudeBinaryImpl();
}

export function __setFindClaudeBinaryForTests(
  fn: (() => Promise<string | null>) | null,
): void {
  findClaudeBinaryImpl = fn ?? defaultFindClaudeBinary;
}

export function __setBuildSpawnHandleForTests(
  fn: typeof buildSpawnHandle | null,
): void {
  buildSpawnHandleImpl = fn ?? buildSpawnHandle;
}

const CLAUDE_BINARY_MISSING_MESSAGE =
  "claude CLI not found in $PATH; install Anthropic's claude binary or set MINIONS_PROVIDER=mock for offline mode";

export const claudeCodeProvider: AgentProvider = {
  name: "claude-code",

  async spawn(opts: ProviderSpawnOpts): Promise<ProviderHandle> {
    const claudeBin = await findClaudeBinary();
    if (!claudeBin) {
      throw new EngineError("upstream", CLAUDE_BINARY_MISSING_MESSAGE, {
        provider: "claude-code",
        op: "spawn",
        sessionSlug: opts.sessionSlug,
      });
    }

    let resolvedOpts: ProviderSpawnOpts = opts;
    if (opts.permissionTier === "worktree") {
      const { gitDir, gitCommonDir } = await resolveWorktreeGitPaths(opts.worktree);
      resolvedOpts = { ...opts, worktreeGitDir: gitDir, worktreeGitCommonDir: gitCommonDir };
    }

    const args = buildSpawnArgs(resolvedOpts);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...opts.env,
    };

    if (opts.attachments && opts.attachments.length > 0) {
      const uploadsDir = opts.env["MINIONS_UPLOADS_DIR"] ?? "";
      for (const att of opts.attachments) {
        const attPath = path.join(uploadsDir, att.name);
        const buf = Buffer.from(att.dataBase64, "base64");
        await fs.writeFile(attPath, buf);
      }
    }

    return buildSpawnHandleImpl(claudeBin, args, { cwd: opts.worktree, env });
  },

  async resume(opts: ProviderResumeOpts): Promise<ProviderHandle> {
    const claudeBin = await findClaudeBinary();
    if (!claudeBin) {
      throw new EngineError("upstream", CLAUDE_BINARY_MISSING_MESSAGE, {
        provider: "claude-code",
        op: "resume",
        sessionSlug: opts.sessionSlug,
      });
    }

    let resolvedOpts: ProviderResumeOpts = opts;
    if (opts.permissionTier === "worktree") {
      const { gitDir, gitCommonDir } = await resolveWorktreeGitPaths(opts.worktree);
      resolvedOpts = { ...opts, worktreeGitDir: gitDir, worktreeGitCommonDir: gitCommonDir };
    }

    const args = buildResumeArgs(resolvedOpts);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...opts.env,
    };

    return buildSpawnHandleImpl(claudeBin, args, { cwd: opts.worktree, env });
  },

  parseStreamChunk(buf: string, state: ParseStreamState): { events: ProviderEvent[]; state: ParseStreamState } {
    const newState = { ...state, buffer: state.buffer + buf };
    const events: ProviderEvent[] = [];

    const lines = newState.buffer.split("\n");
    newState.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const obj = parseNdjsonLine(line);
      if (!obj) continue;
      const { events: evts, state: s } = ndjsonToEvents(obj, newState);
      Object.assign(newState, s);
      events.push(...evts);
    }

    return { events, state: newState };
  },

  detectQuotaError(text: string): boolean {
    const lower = text.toLowerCase();
    return lower.includes("rate limit") || lower.includes("quota");
  },
};
