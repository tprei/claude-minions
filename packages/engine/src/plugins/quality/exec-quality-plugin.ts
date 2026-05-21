import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CommandRunner } from "../command-runner.js";
import type { QualityPlugin, QualityGateConfig, QualityCheckResult, QualityRunResult } from "../quality-plugin.js";
import { createLogger, type Logger } from "../../observability/logger.js";

const MAX_TAIL = 4096;
const UNSAFE_SHELL_METACHARS = new Set([";", "|", "&", "<", ">", "\n", "\r"]);

function tail(s: string): string {
  return s.length <= MAX_TAIL ? s : s.slice(s.length - MAX_TAIL);
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveWorkspaceCwd(workspacePath: string, cwdRel: string | undefined): string {
  const workspaceRoot = resolve(workspacePath);
  const cwd = resolve(workspaceRoot, cwdRel ?? ".");
  if (!isPathInside(workspaceRoot, cwd)) {
    throw new Error(`quality cwdRel "${cwdRel ?? "."}" escapes workspace ${workspaceRoot}`);
  }
  return cwd;
}

function parseQualityCommand(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | "\"" | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      inToken = true;
      continue;
    }

    if (quote === "\"") {
      if (ch === "\"") {
        quote = null;
        inToken = true;
        continue;
      }
      if (ch === "\\") {
        const next = command[i + 1];
        if (next === undefined) {
          throw new Error(`quality command "${command}" ends with an incomplete escape`);
        }
        if (next === "\n") {
          i += 1;
          inToken = true;
          continue;
        }
        if (next === "\"" || next === "\\" || next === "$" || next === "`") {
          current += next;
          i += 1;
          inToken = true;
          continue;
        }
      }
      current += ch;
      inToken = true;
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      throw new Error(`quality command "${command}" uses unsupported shell metacharacter "${ch}"`);
    }
    if (/\s/u.test(ch)) {
      if (inToken) {
        argv.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    if (ch === "'") {
      quote = "'";
      inToken = true;
      continue;
    }
    if (ch === "\"") {
      quote = "\"";
      inToken = true;
      continue;
    }
    if (ch === "\\") {
      const next = command[i + 1];
      if (next === undefined) {
        throw new Error(`quality command "${command}" ends with an incomplete escape`);
      }
      if (next === "\n") {
        i += 1;
        inToken = true;
        continue;
      }
      current += next;
      i += 1;
      inToken = true;
      continue;
    }
    if (UNSAFE_SHELL_METACHARS.has(ch)) {
      throw new Error(`quality command "${command}" uses unsupported shell metacharacter "${ch}"`);
    }
    current += ch;
    inToken = true;
  }

  if (quote === "'" || quote === "\"") {
    throw new Error(`quality command "${command}" has an unterminated quote`);
  }
  if (inToken) {
    argv.push(current);
  }
  if (argv.length === 0) {
    throw new Error("quality command must not be empty");
  }
  return argv;
}

function prepareCommand(workspacePath: string, cfg: QualityGateConfig): { argv: string[]; cwd: string } {
  return {
    argv: parseQualityCommand(cfg.command),
    cwd: resolveWorkspaceCwd(workspacePath, cfg.cwdRel),
  };
}

export class ExecQualityPlugin implements QualityPlugin {
  private readonly log: Logger;
  constructor(private readonly runner: CommandRunner, log: Logger = createLogger("info", [])) {
    this.log = log;
  }

  async loadConfig(workspacePath: string): Promise<QualityGateConfig[]> {
    const configPath = join(workspacePath, ".minions", "quality.json");
    let raw: string;
    try {
      raw = await readFile(configPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`quality.json contains malformed JSON at ${configPath}`);
    }

    if (!Array.isArray(parsed)) {
      this.log.warn(`quality.json is not an array at ${configPath}, ignoring`, { configPath });
      return [];
    }

    const configs: QualityGateConfig[] = [];
    for (const entry of parsed) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>)["name"] === "string" &&
        typeof (entry as Record<string, unknown>)["command"] === "string"
      ) {
        const config = entry as QualityGateConfig;
        prepareCommand(workspacePath, config);
        configs.push(config);
      } else {
        this.log.warn("quality.json: skipping invalid entry", { configPath });
      }
    }
    return configs;
  }

  async run(
    configs: QualityGateConfig[],
    workspacePath: string,
    opts: { signal?: AbortSignal; defaultTimeoutMs?: number },
  ): Promise<QualityRunResult> {
    const defaultTimeoutMs = opts.defaultTimeoutMs ?? 5 * 60_000;
    const checks: QualityCheckResult[] = [];

    for (const cfg of configs) {
      const id = randomUUID();
      const prepared = prepareCommand(workspacePath, cfg);
      const startedAt = new Date().toISOString();
      const t0 = Date.now();

      const runOpts: Parameters<typeof this.runner.run>[0] = {
        cwd: prepared.cwd,
        argv: prepared.argv,
        timeoutMs: cfg.timeoutMs ?? defaultTimeoutMs,
      };
      if (opts.signal) runOpts.signal = opts.signal;
      const result = await this.runner.run(runOpts);

      const durationMs = Date.now() - t0;
      const status: "passed" | "failed" = result.exitCode === 0 ? "passed" : "failed";

      checks.push({
        id,
        name: cfg.name,
        command: cfg.command,
        status,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs,
        exitCode: result.timedOut ? -1 : result.exitCode,
        stdoutTail: tail(result.stdout),
        stderrTail: tail(result.stderr),
      });
    }

    const failed = checks.filter((c) => c.status === "failed");
    const requiredNames = new Set(
      configs.filter((c) => c.required !== false).map((c) => c.name),
    );
    const requiredFailed = failed.filter((c) => requiredNames.has(c.name));

    let status: QualityRunResult["status"];
    if (requiredFailed.length > 0) {
      status = "failed";
    } else if (failed.length > 0) {
      status = "partial";
    } else {
      status = "passed";
    }

    return { status, checks };
  }
}
