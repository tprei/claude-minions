#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { RingBuffer, RotatingFileWriter } from "./log-rotation.js";

export interface NextDelayResult {
  delay: number;
  index: number;
}

export function nextDelayMs(
  history: number[],
  now: number,
  schedule: number[],
  windowMs: number,
): NextDelayResult {
  if (schedule.length === 0) throw new Error("schedule must be non-empty");
  const recent = history.filter((t) => t >= now - windowMs);
  const idx = Math.min(recent.length, schedule.length - 1);
  const delay = schedule[idx]!;
  return { delay, index: idx };
}

interface SuperviseConfig {
  logDir: string;
  crashLogDir: string;
  engineCmd: string;
  backoffMs: number[];
  gracefulMs: number;
  resetWindowMs: number;
  tailLines: number;
}

function parseBackoff(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number.parseInt(s, 10));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    return null;
  }
  return parts;
}

function loadConfig(env: NodeJS.ProcessEnv): SuperviseConfig {
  const home = os.homedir();
  return {
    logDir: env.MINIONS_LOG_DIR ?? path.join(home, ".minions", "logs"),
    crashLogDir: env.MINIONS_CRASH_LOG_DIR ?? path.join(home, ".minions", "crashes"),
    engineCmd: env.MINIONS_ENGINE_CMD ?? "node packages/engine/dist/cli.js",
    backoffMs:
      parseBackoff(env.MINIONS_SUPERVISE_BACKOFF_MS_OVERRIDE) ??
      [2000, 5000, 15000, 30000, 60000],
    gracefulMs: 10_000,
    resetWindowMs: 5 * 60_000,
    tailLines: 200,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeStderrJson(event: string, payload: Record<string, unknown>): void {
  const line = JSON.stringify({ event, ts: new Date().toISOString(), ...payload });
  process.stderr.write(`${line}\n`);
}

async function runSupervisor(config: SuperviseConfig): Promise<number> {
  fs.mkdirSync(config.logDir, { recursive: true });
  fs.mkdirSync(config.crashLogDir, { recursive: true });

  const writer = new RotatingFileWriter(path.join(config.logDir, "engine.log"), {
    maxBytes: 50 * 1024 * 1024,
    keep: 5,
  });

  const history: number[] = [];
  let restartCount = 0;
  let shuttingDown = false;
  const shutdownExitCode = 0;
  let currentChild: ChildProcess | null = null;

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      // Re-entrant: forward again to current child if still alive.
      if (currentChild && currentChild.exitCode === null && currentChild.signalCode === null) {
        try {
          currentChild.kill(signal);
        } catch {
          // ignore
        }
      }
      return;
    }
    shuttingDown = true;
    writeStderrJson("supervisor_shutdown", { signal });
    const child = currentChild;
    if (!child) return;
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        writeStderrJson("supervisor_kill", { reason: "graceful_timeout", gracefulMs: config.gracefulMs });
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, config.gracefulMs).unref();
  };

  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGHUP", () => handleSignal("SIGHUP"));

  while (true) {
    const ring = new RingBuffer(config.tailLines);
    const startedAt = Date.now();

    const child = spawn("sh", ["-c", config.engineCmd], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    currentChild = child;

    writeStderrJson("child_spawn", { pid: child.pid ?? null, restartCount });

    const pipeStream = (stream: NodeJS.ReadableStream | null, tag: string): Promise<void> => {
      if (!stream) return Promise.resolve();
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const tagged = `[${tag}] ${line}`;
        ring.push(tagged);
        try {
          writer.write(`${tagged}\n`);
        } catch {
          // ignore writer errors so we keep supervising
        }
      });
      return new Promise((resolve) => rl.once("close", () => resolve()));
    };

    const stdoutDone = pipeStream(child.stdout, "stdout");
    const stderrDone = pipeStream(child.stderr, "stderr");

    const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; errored: boolean }>(
      (resolve) => {
        let settled = false;
        child.once("error", (err) => {
          if (settled) return;
          settled = true;
          writeStderrJson("child_spawn_error", { message: (err as Error).message });
          resolve({ code: null, signal: null, errored: true });
        });
        child.once("exit", (code, signal) => {
          if (settled) return;
          settled = true;
          resolve({ code, signal, errored: false });
        });
      },
    );

    currentChild = null;
    await Promise.all([stdoutDone, stderrDone]);
    const durationMs = Date.now() - startedAt;

    if (shuttingDown) {
      writeStderrJson("supervisor_clean_exit", {
        reason: "shutdown",
        code: exitInfo.code,
        signal: exitInfo.signal,
        durationMs,
      });
      await writer.close();
      return shutdownExitCode;
    }

    if (!exitInfo.errored && exitInfo.code === 0 && exitInfo.signal === null) {
      writeStderrJson("supervisor_clean_exit", {
        reason: "child_clean_exit",
        code: 0,
        signal: null,
        durationMs,
      });
      await writer.close();
      return 0;
    }

    const now = Date.now();
    const { delay } = nextDelayMs(history, now, config.backoffMs, config.resetWindowMs);
    restartCount += 1;

    const headerObj = {
      event: "child_crash",
      code: exitInfo.code,
      signal: exitInfo.signal,
      pid: child.pid ?? null,
      durationMs,
      restartCount,
      nextDelayMs: delay,
      errored: exitInfo.errored,
      ts: new Date(now).toISOString(),
    };

    const isoStamp = new Date(now).toISOString().replace(/[:]/g, "-");
    const crashFile = path.join(
      config.crashLogDir,
      `${isoStamp}-${restartCount}.log`,
    );
    const tail = ring.snapshot().join("\n");
    try {
      fs.writeFileSync(crashFile, `${JSON.stringify(headerObj)}\n\n${tail}\n`);
    } catch (err) {
      writeStderrJson("crash_log_write_failed", { message: (err as Error).message });
    }

    writeStderrJson("child_crash", {
      code: headerObj.code,
      signal: headerObj.signal,
      pid: headerObj.pid,
      durationMs: headerObj.durationMs,
      restartCount: headerObj.restartCount,
      nextDelayMs: headerObj.nextDelayMs,
      errored: headerObj.errored,
      crashFile,
    });

    history.push(now);
    while (history.length > 0 && history[0]! < now - config.resetWindowMs) {
      history.shift();
    }

    await sleep(delay);

    if (shuttingDown) {
      await writer.close();
      return shutdownExitCode;
    }
  }
}

function isMainEntry(): boolean {
  const argvEntry = process.argv[1];
  if (!argvEntry) return false;
  try {
    return import.meta.url === pathToFileURL(argvEntry).href;
  } catch {
    return false;
  }
}

function flushStderr(): Promise<void> {
  return new Promise((resolve) => {
    if (process.stderr.write("")) resolve();
    else process.stderr.once("drain", () => resolve());
  });
}

if (isMainEntry()) {
  (async () => {
    let code = 1;
    try {
      const config = loadConfig(process.env);
      code = await runSupervisor(config);
    } catch (err) {
      writeStderrJson("supervisor_fatal", {
        message: (err as Error).message,
        stack: (err as Error).stack,
      });
    }
    await flushStderr();
    process.exit(code);
  })();
}
