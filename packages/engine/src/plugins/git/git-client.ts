import { spawn } from "node:child_process";

export interface GitClientConfig {
  gitBin?: string;
  commandPrefix?: readonly string[];
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
  private readonly bin: string;
  private readonly commandPrefix: readonly string[];

  constructor(config: GitClientConfig = {}) {
    this.bin = config.gitBin ?? "git";
    this.commandPrefix = config.commandPrefix ?? [];
  }

  run(
    cwd: string,
    args: readonly string[],
    opts?: { env?: Record<string, string> },
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

      proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      proc.on("close", (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const exitCode = code ?? 1;
        if (exitCode === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new GitError(`git exited with code ${exitCode}`, stdout, stderr, exitCode));
        }
      });

      proc.on("error", (err) => reject(err));
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
}
