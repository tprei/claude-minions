import { execFile } from "node:child_process";
import type { CommandRunner, CommandRunOptions, CommandRunResult } from "../command-runner.js";

export class HostCommandRunner implements CommandRunner {
  run(opts: CommandRunOptions): Promise<CommandRunResult> {
    if (opts.argv.length === 0) {
      return Promise.reject(new Error("command argv must not be empty"));
    }
    return new Promise<CommandRunResult>((resolve) => {
      const execOpts: Parameters<typeof execFile>[2] = {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        maxBuffer: 10 * 1024 * 1024,
      };
      if (opts.timeoutMs !== undefined) {
        execOpts.timeout = opts.timeoutMs;
        execOpts.killSignal = "SIGKILL";
      }
      if (opts.signal) {
        execOpts.signal = opts.signal;
      }

      const [file, ...args] = opts.argv;
      execFile(
        file!,
        args,
        execOpts,
        (err, stdout, stderr) => {
          const e = err as { code?: number | string; killed?: boolean; name?: string } | null;
          const isTimedOut = e?.killed === true || e?.code === "ABORT_ERR" || e?.name === "AbortError";
          const exitCode =
            isTimedOut
              ? -1
              : e && typeof e.code === "number"
                ? e.code
                : e
                  ? 1
                  : 0;
          resolve({
            exitCode,
            stdout: typeof stdout === "string" ? stdout : (stdout as Buffer).toString("utf-8"),
            stderr: typeof stderr === "string" ? stderr : (stderr as Buffer).toString("utf-8"),
            timedOut: isTimedOut,
          });
        },
      );
    });
  }
}
