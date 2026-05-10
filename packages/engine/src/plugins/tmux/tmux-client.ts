import { spawn } from "node:child_process";

export interface TmuxClientConfig {
  socketName: string;
  tmuxBin?: string;
  commandPrefix?: readonly string[];
}

export class TmuxError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;

  constructor(message: string, stdout: string, stderr: string, exitCode: number) {
    super(message);
    this.name = "TmuxError";
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export class TmuxNoSuchSessionError extends TmuxError {
  constructor(stdout: string, stderr: string, exitCode: number) {
    super("no such session", stdout, stderr, exitCode);
    this.name = "TmuxNoSuchSessionError";
  }
}

const NO_SUCH_SESSION_RE = /no such session|session not found|can't find session|no server running|target pane has exited/i;

function shellQuotePath(p: string): string {
  return "'" + p.replace(/'/g, "'\\''") + "'";
}

export class TmuxClient {
  private readonly bin: string;
  private readonly socketName: string;
  private readonly commandPrefix: readonly string[];

  constructor(config: TmuxClientConfig) {
    this.bin = config.tmuxBin ?? "tmux";
    this.socketName = config.socketName;
    this.commandPrefix = config.commandPrefix ?? [];
  }

  private run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const tmuxArgs = ["-L", this.socketName, ...args];
      const [spawnBin, spawnArgs] = this.commandPrefix.length > 0
        ? [this.commandPrefix[0]!, [...this.commandPrefix.slice(1), this.bin, ...tmuxArgs]]
        : [this.bin, tmuxArgs];
      const proc = spawn(spawnBin, spawnArgs);
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      proc.on("close", (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const exitCode = code ?? 1;

        if (exitCode === 0) {
          resolve({ stdout, stderr });
        } else if (NO_SUCH_SESSION_RE.test(stderr)) {
          reject(new TmuxNoSuchSessionError(stdout, stderr, exitCode));
        } else {
          reject(new TmuxError(`tmux exited with code ${exitCode}`, stdout, stderr, exitCode));
        }
      });

      proc.on("error", (err) => reject(err));
    });
  }

  async newSession(args: { name: string; scriptPath: string }): Promise<void> {
    // tmux re-parses the trailing arg as a shell command, so paths with spaces or
    // metacharacters silently fail unless quoted at the shell-string level.
    await this.run(["new-session", "-d", "-s", args.name, shellQuotePath(args.scriptPath)]);
  }

  async setWindowOption(name: string, key: string, value: string): Promise<void> {
    await this.run(["set-window-option", "-t", name, key, value]);
  }

  async pipePane(name: string, logPath: string): Promise<void> {
    const quotedPath = shellQuotePath(logPath);
    const quotedDone = shellQuotePath(`${logPath}.done`);
    await this.run(["pipe-pane", "-t", name, "-o", `cat >> ${quotedPath}; touch ${quotedDone}`]);
  }

  async pipePaneOff(name: string): Promise<void> {
    await this.run(["pipe-pane", "-t", name]);
  }

  async waitForSignal(token: string): Promise<void> {
    await this.run(["wait-for", "-S", token]);
  }

  async sessionExists(name: string): Promise<boolean> {
    try {
      await this.run(["has-session", "-t", name]);
      return true;
    } catch (err) {
      if (err instanceof TmuxNoSuchSessionError) return false;
      throw err;
    }
  }

  async paneDead(name: string): Promise<boolean> {
    const { stdout } = await this.run(["display-message", "-p", "-t", name, "#{pane_dead}"]);
    const trimmed = stdout.trim();
    if (trimmed === "1") return true;
    if (trimmed === "0") return false;
    throw new TmuxError(
      `unexpected pane_dead value: ${trimmed}`,
      stdout,
      "",
      0,
    );
  }

  async killSession(name: string): Promise<void> {
    await this.run(["kill-session", "-t", name]);
  }
}
