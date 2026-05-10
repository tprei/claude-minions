import { createHash, randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import type { RuntimeProbeState } from "../../application/recovery.js";
import type {
  RuntimeAttachOptions,
  RuntimeBackend,
  RuntimeOutputChunk,
  RuntimeStartResult,
  RuntimeStartSpec,
} from "../runtime-backend.js";
import { buildLauncherScript } from "./launcher-script.js";
import {
  LOG_READ_CHUNK_SIZE,
  PANE_PROBE_INTERVAL_MS,
  SENTINEL_POLL_INTERVAL_MS,
  SENTINEL_TIMEOUT_MS,
} from "./constants.js";
import { followLog } from "./log-follow.js";
import { TmuxClient, TmuxError, TmuxNoSuchSessionError } from "./tmux-client.js";

export interface TmuxRuntimeConfig {
  dataDir: string;
  socketName?: string;
  tmuxBin?: string;
  shortIdLen?: number;
  commandPrefix?: readonly string[];
  workerSessionsDir?: string;
}

const DOCKER_DOWN_RE = /\b(?:is not running|is dead|No such container)\b/i;

function isDockerDown(err: unknown): boolean {
  return err instanceof TmuxError && DOCKER_DOWN_RE.test(err.stderr);
}

function makeSessionId(taskId: string, shortIdLen: number): string {
  const slug = taskId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "task";
  const hash8 = createHash("sha1").update(taskId).digest("hex").slice(0, 8);
  const shortId = randomBytes(Math.ceil(shortIdLen / 2))
    .toString("hex")
    .slice(0, shortIdLen);
  return `mwf-${slug}-${hash8}-${shortId}`;
}

export class TmuxRuntimeBackend implements RuntimeBackend {
  private readonly client: TmuxClient;
  private readonly config: Required<TmuxRuntimeConfig>;

  constructor(config: TmuxRuntimeConfig) {
    this.config = {
      dataDir: config.dataDir,
      socketName: config.socketName ?? "minions",
      tmuxBin: config.tmuxBin ?? "tmux",
      shortIdLen: config.shortIdLen ?? 6,
      commandPrefix: config.commandPrefix ?? [],
      workerSessionsDir: config.workerSessionsDir ?? `${config.dataDir}/sessions`,
    };
    this.client = new TmuxClient({
      socketName: this.config.socketName,
      tmuxBin: this.config.tmuxBin,
      commandPrefix: this.config.commandPrefix,
    });
  }

  async start(spec: RuntimeStartSpec): Promise<RuntimeStartResult> {
    if (spec.command.length === 0 || (spec.command[0] ?? "").trim() === "") {
      throw new Error("command must be non-empty");
    }

    const sessionId = makeSessionId(spec.taskId, this.config.shortIdLen);
    const releaseToken = `release-${sessionId}`;

    await fsp.mkdir(`${this.config.dataDir}/sessions`, { recursive: true });

    const scriptPath = `${this.config.dataDir}/sessions/${sessionId}.sh`;
    const logPath = `${this.config.dataDir}/sessions/${sessionId}.log`;

    await fsp.writeFile(
      scriptPath,
      buildLauncherScript({
        command: spec.command,
        ...(spec.env !== undefined ? { env: spec.env } : {}),
        // spec.workspacePath is worker-POV: caller must supply the path as seen inside the container
        ...(spec.workspacePath !== undefined ? { cwd: spec.workspacePath } : {}),
        socketName: this.config.socketName,
        releaseToken,
        tmuxBin: this.config.tmuxBin,
      }),
      { mode: 0o755 },
    );

    // Touch the log file so followLog can open it immediately
    await fsp.writeFile(logPath, "", { flag: "a" });

    const workerScriptPath = `${this.config.workerSessionsDir}/${sessionId}.sh`;
    const workerLogPath = `${this.config.workerSessionsDir}/${sessionId}.log`;

    await this.client.newSession({ name: sessionId, scriptPath: workerScriptPath });

    try {
      await this.client.setWindowOption(sessionId, "remain-on-exit", "on");
      await this.client.pipePane(sessionId, workerLogPath);
      await this.client.waitForSignal(releaseToken);
    } catch (err) {
      await this.client.killSession(sessionId).catch(() => {});
      throw err;
    }

    return { sessionId, runtimeType: "tmux" };
  }

  async stop(sessionId: string): Promise<void> {
    try {
      await this.client.pipePaneOff(sessionId).catch((err) => {
        if (err instanceof TmuxNoSuchSessionError || isDockerDown(err)) return;
        throw err;
      });
      await this.client.killSession(sessionId);
    } catch (err) {
      if (err instanceof TmuxNoSuchSessionError || isDockerDown(err)) return;
      throw err;
    }
  }

  async probe(sessionId: string): Promise<RuntimeProbeState> {
    try {
      const exists = await this.client.sessionExists(sessionId);
      if (!exists) return "missing";
      const dead = await this.client.paneDead(sessionId);
      return dead ? "dead" : "live";
    } catch (err) {
      if (this.config.commandPrefix.length > 0 && isDockerDown(err)) {
        return "missing";
      }
      throw err;
    }
  }

  async *attach(
    sessionId: string,
    opts: RuntimeAttachOptions = {},
  ): AsyncIterable<RuntimeOutputChunk> {
    const logPath = `${this.config.dataDir}/sessions/${sessionId}.log`;
    const donePath = `${logPath}.done`;
    const fromOffset = opts.fromOffset ?? 0;
    const internal = new AbortController();
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, internal.signal])
      : internal.signal;

    let terminated = false;
    let lastOffset = fromOffset;

    const pollTimer = setInterval(async () => {
      if (terminated || signal.aborted) return;
      let dead = false;
      try {
        dead = await this.client.paneDead(sessionId);
      } catch (err) {
        if (
          err instanceof TmuxNoSuchSessionError ||
          (this.config.commandPrefix.length > 0 && isDockerDown(err))
        ) {
          dead = true;
        } else {
          return;
        }
      }
      if (dead && !terminated) {
        terminated = true;
        internal.abort();
      }
    }, PANE_PROBE_INTERVAL_MS);

    try {
      for await (const chunk of followLog(logPath, fromOffset, signal)) {
        lastOffset = chunk.offset + chunk.bytes.byteLength;
        yield { sessionId, offset: chunk.offset, bytes: chunk.bytes };
      }
    } finally {
      clearInterval(pollTimer);
      internal.abort();
    }

    if (!terminated || opts.signal?.aborted) return;

    await this.client.pipePaneOff(sessionId).catch((err) => {
      if (err instanceof TmuxNoSuchSessionError || isDockerDown(err)) return;
      throw err;
    });

    // Poll for the sentinel written by the pipe-pane wrapper (`cat >> log; touch log.done`).
    // The sentinel only appears after cat exits (i.e., after all bytes are flushed to the
    // log). The cap is a safety net; under normal conditions the sentinel appears first.
    const deadline = Date.now() + SENTINEL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await fsp.access(donePath);
        break;
      } catch {
        // sentinel not yet present
      }
      await new Promise<void>((r) => setTimeout(r, SENTINEL_POLL_INTERVAL_MS));
    }

    const handle = await fsp.open(logPath, "r").catch(() => null);
    if (handle === null) return;
    try {
      const stat = await handle.stat();
      const finalSize = stat.size;
      let readOffset = lastOffset;
      while (readOffset < finalSize) {
        const toRead = Math.min(LOG_READ_CHUNK_SIZE, finalSize - readOffset);
        const buf = Buffer.allocUnsafe(toRead);
        const { bytesRead } = await handle.read(buf, 0, toRead, readOffset);
        if (bytesRead === 0) break;
        yield { sessionId, offset: readOffset, bytes: new Uint8Array(buf.buffer, buf.byteOffset, bytesRead) };
        readOffset += bytesRead;
      }
    } finally {
      await handle.close();
      // Clean up the transient drain sentinel; swallow if already gone.
      await fsp.unlink(donePath).catch(() => {});
    }
  }
}
