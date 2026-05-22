import { spawn } from "node:child_process";
import type { MergeResult } from "../scm-plugin.js";

export interface GitClientConfig {
  gitBin?: string;
  commandPrefix?: readonly string[];
  timeoutMs?: number;
}

export class GitError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;

  constructor(message: string, stdout: string, stderr: string, exitCode: number) {
    super(message);
    this.name = "GitError";
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export interface WorktreeEntry {
  path: string;
  head: string;
  branch?: string | undefined;
}

export class GitClient {
  private static readonly DEFAULT_TIMEOUT_MS = 120_000;

  private readonly bin: string;
  private readonly commandPrefix: readonly string[];
  private readonly timeoutMs: number;

  constructor(config: GitClientConfig = {}) {
    this.bin = config.gitBin ?? "git";
    this.commandPrefix = config.commandPrefix ?? [];
    this.timeoutMs = config.timeoutMs ?? GitClient.DEFAULT_TIMEOUT_MS;
  }

  run(
    cwd: string,
    args: readonly string[],
    opts?: { env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const [spawnBin, spawnArgs] =
        this.commandPrefix.length > 0
          ? [
              this.commandPrefix[0]!,
              [...this.commandPrefix.slice(1), this.bin, ...args],
            ]
          : [this.bin, [...args]];

      const spawnEnv = opts?.env !== undefined
        ? { ...process.env, ...opts.env }
        : undefined;

      const proc = spawn(spawnBin, spawnArgs, { cwd, ...(spawnEnv !== undefined ? { env: spawnEnv } : {}) });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      let sigkillTimer: NodeJS.Timeout | undefined;

      proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      if (timeoutMs > 0) {
        killTimer = setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
          sigkillTimer = setTimeout(() => proc.kill("SIGKILL"), 1_000);
        }, timeoutMs);
      }

      proc.on("close", (code) => {
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (timedOut) {
          reject(new GitError(`git timed out after ${timeoutMs}ms`, stdout, stderr, 124));
          return;
        }
        const exitCode = code ?? 1;
        if (exitCode === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new GitError(`git exited with code ${exitCode}`, stdout, stderr, exitCode));
        }
      });

      proc.on("error", (err) => {
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
        reject(err);
      });
    });
  }

  async worktreeAdd(
    repoPath: string,
    opts: { path: string; branch: string; baseRef?: string; resetBranch?: boolean },
  ): Promise<void> {
    if (opts.resetBranch === true) {
      await this.run(repoPath, ["worktree", "add", "-B", opts.branch, opts.path, opts.baseRef ?? "HEAD"]);
    } else {
      const exists = await this.branchExists(repoPath, opts.branch);
      if (exists) {
        await this.run(repoPath, ["worktree", "add", opts.path, opts.branch]);
      } else {
        await this.run(repoPath, ["worktree", "add", "-b", opts.branch, opts.path, opts.baseRef ?? "HEAD"]);
      }
    }
  }

  async worktreeRemove(
    repoPath: string,
    worktreePath: string,
    opts?: { force?: boolean },
  ): Promise<void> {
    const args: string[] = ["worktree", "remove"];
    if (opts?.force) args.push("--force");
    args.push(worktreePath);
    await this.run(repoPath, args);
  }

  async worktreePrune(repoPath: string): Promise<void> {
    await this.run(repoPath, ["worktree", "prune"]);
  }

  async worktreeList(repoPath: string): Promise<WorktreeEntry[]> {
    const { stdout } = await this.run(repoPath, ["worktree", "list", "--porcelain"]);
    const entries: WorktreeEntry[] = [];
    let current: Partial<WorktreeEntry> | null = null;

    for (const rawLine of stdout.split("\n")) {
      const line = rawLine.trimEnd();
      if (line === "") {
        if (current?.path && current.head) {
          const entry: WorktreeEntry = { path: current.path, head: current.head };
          if (current.branch !== undefined) entry.branch = current.branch;
          entries.push(entry);
        }
        current = null;
        continue;
      }
      if (current === null) current = {};
      if (line.startsWith("worktree ")) {
        current.path = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length);
      }
    }
    if (current?.path && current.head) {
      const entry: WorktreeEntry = { path: current.path, head: current.head };
      if (current.branch !== undefined) entry.branch = current.branch;
      entries.push(entry);
    }
    return entries;
  }

  async revParse(repoPath: string, ref: string): Promise<string> {
    const { stdout } = await this.run(repoPath, ["rev-parse", ref]);
    return stdout.trim();
  }

  async branchExists(repoPath: string, branch: string): Promise<boolean> {
    try {
      await this.run(repoPath, ["rev-parse", "--verify", branch]);
      return true;
    } catch {
      return false;
    }
  }

  async listConflictedFiles(path: string): Promise<string[]> {
    const { stdout } = await this.run(path, ["diff", "--name-only", "--diff-filter=U"]);
    return stdout.trim().split("\n").filter(Boolean);
  }

  async hasConflictMarkers(path: string): Promise<boolean> {
    try {
      // Match only the unambiguous start/end markers (7+ chars, supporting a
      // configured conflict-marker-size); a bare "=======" line is a valid
      // Markdown setext heading underline and must not be treated as a conflict.
      await this.run(path, ["grep", "-lE", "^(<{7,}|>{7,})( |$)", "--", "."]);
      return true;
    } catch (err) {
      if (err instanceof GitError && err.exitCode === 1) return false;
      throw err;
    }
  }

  async addAll(path: string): Promise<void> {
    await this.run(path, ["add", "-A"]);
  }

  async rebaseContinue(path: string): Promise<MergeResult> {
    try {
      await this.run(path, ["-c", "core.editor=true", "rebase", "--continue"]);
      return { kind: "clean" };
    } catch (err) {
      if (err instanceof GitError && /CONFLICT/i.test(err.stdout + err.stderr)) {
        return { kind: "conflict", conflictPaths: await this.listConflictedFiles(path) };
      }
      throw err;
    }
  }

  async rebaseAbort(path: string): Promise<void> {
    await this.run(path, ["rebase", "--abort"]).catch(() => {});
  }

  async isRebaseInProgress(path: string): Promise<boolean> {
    try {
      await this.run(path, ["rebase", "--show-current-patch"]);
      return true;
    } catch (err) {
      if (err instanceof GitError && /no rebase in progress/i.test(err.stdout + err.stderr)) return false;
      throw err;
    }
  }

  async statusIsClean(path: string): Promise<boolean> {
    const { stdout } = await this.run(path, ["status", "--porcelain"]);
    return stdout.trim().length === 0;
  }
}
