import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CommandRunner } from "../command-runner.js";
import type { QualityPlugin, QualityGateConfig, QualityCheckResult, QualityRunResult } from "../quality-plugin.js";
import { createLogger, type Logger } from "../../observability/logger.js";

const MAX_TAIL = 4096;

function tail(s: string): string {
  return s.length <= MAX_TAIL ? s : s.slice(s.length - MAX_TAIL);
}

function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let running = 0;
  const queue: Array<() => void> = [];

  function next(): void {
    if (queue.length > 0 && running < concurrency) {
      running++;
      queue.shift()!();
    }
  }

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            running--;
            next();
          });
      });
      next();
    });
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
        configs.push(entry as QualityGateConfig);
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
    const limit = pLimit(2);

    const checks = await Promise.all(
      configs.map((cfg) =>
        limit(async (): Promise<QualityCheckResult> => {
          const id = randomUUID();
          const cwd = join(workspacePath, cfg.cwdRel ?? "");
          const startedAt = new Date().toISOString();
          const t0 = Date.now();

          const runOpts: Parameters<typeof this.runner.run>[0] = {
            cwd,
            command: cfg.command,
            timeoutMs: cfg.timeoutMs ?? defaultTimeoutMs,
          };
          if (opts.signal) runOpts.signal = opts.signal;
          const result = await this.runner.run(runOpts);

          const durationMs = Date.now() - t0;
          const status: "passed" | "failed" = result.exitCode === 0 ? "passed" : "failed";

          return {
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
          };
        }),
      ),
    );

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
