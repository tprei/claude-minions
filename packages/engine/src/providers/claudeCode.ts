import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import readline from "node:readline";
import type {
  AgentProvider,
  ProviderHandle,
  ProviderSpawnOpts,
  ProviderResumeOpts,
  ProviderEvent,
  ParseStreamState,
} from "./provider.js";
import { mockProvider } from "./mock.js";

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
      events.push({ kind: "turn_started" });
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
      if (subtype === "success") {
        events.push({ kind: "turn_completed", outcome: "success", stopReason });
      } else if (subtype === "error_max_turns") {
        events.push({ kind: "turn_completed", outcome: "errored", stopReason: "max_turns" });
      } else {
        events.push({ kind: "turn_completed", outcome: "errored", stopReason: subtype });
      }
      break;
    }
    case "user":
      break;
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

async function findClaudeBinary(): Promise<string | null> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);
  try {
    const { stdout } = await execAsync("which claude");
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export const claudeCodeProvider: AgentProvider = {
  name: "claude-code",

  async spawn(opts: ProviderSpawnOpts): Promise<ProviderHandle> {
    const claudeBin = await findClaudeBinary();
    if (!claudeBin) {
      process.stderr.write("[claude-code] claude binary not found, falling back to mock\n");
      return mockProvider.spawn(opts);
    }

    const args = [
      "--output-format", "stream-json",
      "--print",
      "--verbose",
    ];

    if (opts.modelHint) {
      args.push("--model", opts.modelHint);
    }

    const homeDir = opts.env["MINIONS_CLAUDE_HOME"] ?? undefined;
    if (homeDir) {
      args.push("--config-dir", homeDir);
    }

    let fullPrompt = opts.prompt;
    if (opts.preamble) {
      fullPrompt = `${opts.preamble}\n\n---\n\n${opts.prompt}`;
    }

    args.push("--", fullPrompt);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...opts.env,
      HOME: homeDir ?? process.env["HOME"] ?? "/tmp",
    };

    if (opts.attachments && opts.attachments.length > 0) {
      const uploadsDir = opts.env["MINIONS_UPLOADS_DIR"] ?? "";
      for (const att of opts.attachments) {
        const attPath = path.join(uploadsDir, att.name);
        const buf = Buffer.from(att.dataBase64, "base64");
        await fs.writeFile(attPath, buf);
      }
    }

    return buildSpawnHandle(claudeBin, args, { cwd: opts.worktree, env });
  },

  async resume(opts: ProviderResumeOpts): Promise<ProviderHandle> {
    const claudeBin = await findClaudeBinary();
    if (!claudeBin) {
      process.stderr.write("[claude-code] claude binary not found, falling back to mock for resume\n");
      return mockProvider.resume(opts);
    }

    const args = ["--output-format", "stream-json", "--print", "--verbose"];

    if (opts.externalId) {
      args.push("--resume", opts.externalId);
    }

    const homeDir = opts.env["MINIONS_CLAUDE_HOME"] ?? undefined;
    if (homeDir) {
      args.push("--config-dir", homeDir);
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...opts.env,
      HOME: homeDir ?? process.env["HOME"] ?? "/tmp",
    };

    return buildSpawnHandle(claudeBin, args, { cwd: opts.worktree, env });
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
