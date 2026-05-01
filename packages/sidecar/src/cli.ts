import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SidecarClient } from "./client.js";
import { createLogger, parseLevel, type Logger } from "./log.js";
import { RulesEngine } from "./rulesEngine.js";
import { allRules, selectRules } from "./rules/index.js";

function parseRules(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return ["all"];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const HEARTBEAT_INTERVAL_MS = 10_000;
const PIDFILE_NAME = ".sidecar.pid";
const HEARTBEAT_NAME = ".sidecar.heartbeat";

export interface SidecarRuntime {
  shutdown(reason: string): Promise<void>;
}

export interface RunSidecarOptions {
  baseUrl: string;
  token: string;
  workspace: string;
  rules: string[];
  log: Logger;
  pid?: number;
  heartbeatIntervalMs?: number;
}

function writeFileAtomic(target: string, body: string): void {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, target);
}

export function runSidecar(opts: RunSidecarOptions): SidecarRuntime {
  const { baseUrl, token, workspace, log } = opts;
  const pid = opts.pid ?? process.pid;
  const interval = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;

  const selected = selectRules(opts.rules);
  if (selected.length === 0) {
    throw new Error(
      `no rules selected — requested=[${opts.rules.join(",")}], available=[${allRules
        .map((r) => r.id)
        .join(",")}]`,
    );
  }

  fs.mkdirSync(workspace, { recursive: true });

  const pidFile = path.join(workspace, PIDFILE_NAME);
  const heartbeatFile = path.join(workspace, HEARTBEAT_NAME);

  writeFileAtomic(pidFile, String(pid));
  const writeHeartbeat = (): void => {
    writeFileAtomic(heartbeatFile, new Date().toISOString());
  };
  writeHeartbeat();
  const heartbeatTimer = setInterval(writeHeartbeat, interval);
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

  log.info("starting sidecar", {
    baseUrl,
    rules: selected.map((r) => r.id),
    pid,
    pidFile,
    heartbeatFile,
  });

  const client = new SidecarClient({ baseUrl, token, log: log.child({ component: "client" }) });
  const engine = new RulesEngine({
    client,
    rules: selected,
    log: log.child({ component: "rules-engine" }),
  });
  engine.start();

  let stopped = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    log.info("shutting down", { reason });
    clearInterval(heartbeatTimer);
    try {
      await engine.stop();
    } catch (err) {
      log.error("shutdown error", { err: String(err) });
    }
    try {
      fs.unlinkSync(pidFile);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.warn("pidfile unlink failed", { err: String(err) });
      }
    }
  };

  return { shutdown };
}

async function main(): Promise<void> {
  const baseUrl = process.env["MINIONS_ENGINE_URL"] ?? "http://127.0.0.1:8787";
  const token = process.env["MINIONS_TOKEN"];
  if (!token) {
    process.stderr.write("MINIONS_TOKEN is required\n");
    process.exit(1);
  }
  const workspaceRaw = process.env["MINIONS_WORKSPACE"];
  if (!workspaceRaw) {
    process.stderr.write("MINIONS_WORKSPACE is required\n");
    process.exit(1);
  }
  const workspace = path.resolve(workspaceRaw);
  const level = parseLevel(process.env["SIDECAR_LOG_LEVEL"]);
  const requested = parseRules(process.env["SIDECAR_RULES"]);

  const log = createLogger(level, { service: "sidecar" });

  let runtime: SidecarRuntime;
  try {
    runtime = runSidecar({ baseUrl, token, workspace, rules: requested, log });
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const onSignal = (signal: string): void => {
    void runtime.shutdown(signal).then(() => process.exit(0));
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err: unknown) => {
    process.stderr.write(`Fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
