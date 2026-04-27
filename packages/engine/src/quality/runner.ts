import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import pLimit from "p-limit";
import type { QualityGateConfig, QualityCheck, QualityReport } from "@minions/shared";
import { newId } from "../util/ids.js";

const execAsync = promisify(exec);

const MAX_TAIL_BYTES = 4096;

function tail(s: string): string {
  if (s.length <= MAX_TAIL_BYTES) return s;
  return s.slice(s.length - MAX_TAIL_BYTES);
}

export interface RunChecksResult {
  checks: QualityCheck[];
  status: QualityReport["status"];
}

export async function runChecks(
  configs: QualityGateConfig[],
  cwd: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<RunChecksResult> {
  if (configs.length === 0) {
    return { checks: [], status: "pending" };
  }

  const limit = pLimit(2);

  const checks = await Promise.all(
    configs.map((cfg) =>
      limit(async (): Promise<QualityCheck> => {
        const id = newId();
        const checkCwd = cfg.cwdRel ? path.join(cwd, cfg.cwdRel) : cwd;
        const startedAt = new Date().toISOString();
        const t0 = Date.now();

        try {
          const { stdout, stderr } = await execAsync(cfg.command, {
            cwd: checkCwd,
            timeout: cfg.timeoutMs ?? timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
          });
          const durationMs = Date.now() - t0;
          return {
            id,
            name: cfg.name,
            command: cfg.command,
            status: "passed",
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs,
            exitCode: 0,
            stdoutTail: tail(stdout),
            stderrTail: tail(stderr),
          };
        } catch (err) {
          const durationMs = Date.now() - t0;
          const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
          const exitCode = typeof e.code === "number" ? e.code : 1;
          return {
            id,
            name: cfg.name,
            command: cfg.command,
            status: "failed",
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs,
            exitCode,
            stdoutTail: tail(e.stdout ?? ""),
            stderrTail: tail(e.stderr ?? (err as Error).message),
          };
        }
      }),
    ),
  );

  const failed = checks.filter((c) => c.status === "failed");
  const required = configs.filter((c) => c.required !== false);
  const requiredNames = new Set(required.map((r) => r.name));
  const requiredFailed = failed.filter((c) => requiredNames.has(c.name));

  let status: QualityReport["status"];
  if (requiredFailed.length > 0) {
    status = "failed";
  } else if (failed.length > 0) {
    status = "partial";
  } else {
    status = "passed";
  }

  return { checks, status };
}
