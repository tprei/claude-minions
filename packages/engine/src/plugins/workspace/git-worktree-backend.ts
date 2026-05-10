import { join, sep, dirname, basename } from "node:path";
import { realpath, mkdir } from "node:fs/promises";
import type { GitClient } from "../git/git-client.js";
import { GitError } from "../git/git-client.js";
import type { WorkspaceBackend, WorkspaceCreateSpec, WorkspaceHandle } from "../workspace-backend.js";
import { WorkspaceError, slugify } from "../workspace-backend.js";
import type { WorkspaceFs } from "./workspace-fs.js";
import { HostFs, DockerFs } from "./workspace-fs.js";

export interface GitWorktreeBackendConfig {
  gitClient: GitClient;
  repoPath: string;
  workspaceRoot: string;
  gitCommandPrefix?: readonly string[];
}

function isNotFoundError(err: unknown): boolean {
  if (err instanceof GitError) {
    const msg = err.stderr + err.stdout;
    return (
      msg.includes("is not a working tree") ||
      msg.includes("does not exist") ||
      msg.includes("not a working tree")
    );
  }
  return false;
}

export class GitWorktreeWorkspaceBackend implements WorkspaceBackend {
  private static readonly locks: Map<string, Promise<void>> = new Map();

  private readonly gitClient: GitClient;
  private readonly workspaceRoot: string;
  private readonly fs: WorkspaceFs;
  private readonly dockerMode: boolean;
  private readonly handles: Map<string, WorkspaceHandle> = new Map();

  private repoPath: string;

  private constructor(
    gitClient: GitClient,
    repoPath: string,
    workspaceRoot: string,
    fs: WorkspaceFs,
    dockerMode: boolean,
  ) {
    this.gitClient = gitClient;
    this.repoPath = repoPath;
    this.workspaceRoot = workspaceRoot;
    this.fs = fs;
    this.dockerMode = dockerMode;
  }

  static async create(config: GitWorktreeBackendConfig): Promise<GitWorktreeWorkspaceBackend> {
    const dockerMode = (config.gitCommandPrefix?.length ?? 0) > 0;
    const fs: WorkspaceFs = dockerMode
      ? new DockerFs(config.gitCommandPrefix!)
      : new HostFs();

    let repoPath: string;
    let workspaceRoot: string;

    if (dockerMode) {
      // In docker mode, repoPath and workspaceRoot are container-internal paths.
      // The host cannot realpath or mkdir them. Operator owns container-side setup.
      repoPath = config.repoPath;
      workspaceRoot = config.workspaceRoot;
    } else {
      repoPath = await realpath(config.repoPath);
      try {
        workspaceRoot = await realpath(config.workspaceRoot);
      } catch {
        await mkdir(config.workspaceRoot, { recursive: true });
        workspaceRoot = await realpath(config.workspaceRoot);
      }
    }

    return new GitWorktreeWorkspaceBackend(config.gitClient, repoPath, workspaceRoot, fs, dockerMode);
  }

  private async validateContainment(candidate: string): Promise<void> {
    if (this.dockerMode) {
      // In docker mode the host cannot realpath container-internal paths.
      // Validate structurally: the candidate must be exactly one level under workspaceRoot.
      if (!candidate.startsWith(this.workspaceRoot + sep)) {
        throw new WorkspaceError("path_escape", `candidate path escapes workspace root`, {
          candidate,
          workspaceRoot: this.workspaceRoot,
        });
      }
      const relative = candidate.slice(this.workspaceRoot.length + 1);
      if (relative.includes(sep) || relative === "" || relative === "." || relative === "..") {
        throw new WorkspaceError("path_escape", `workspace path must be exactly one level deep`, {
          candidate,
        });
      }
      return;
    }

    const parentResolved = await realpath(dirname(candidate)).catch(() => null);
    if (parentResolved === null) {
      throw new WorkspaceError("path_escape", `parent directory does not exist: ${dirname(candidate)}`);
    }
    const resolved = parentResolved + sep + basename(candidate);

    if (resolved !== this.workspaceRoot && !resolved.startsWith(this.workspaceRoot + sep)) {
      throw new WorkspaceError("path_escape", `candidate path escapes workspace root`, {
        candidate,
        workspaceRoot: this.workspaceRoot,
      });
    }

    const relative = resolved.slice(this.workspaceRoot.length + 1);
    if (relative.includes(sep)) {
      throw new WorkspaceError("path_escape", `workspace path must be exactly one level deep`, {
        candidate,
      });
    }
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const locks = GitWorktreeWorkspaceBackend.locks;
    const prev = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    locks.set(key, prev.then(() => gate));
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  private async probeWorktree(worktreePath: string): Promise<"worktree" | "stale-dir" | "absent"> {
    if (await this.fs.gitMarkerExists(worktreePath)) return "worktree";
    if (await this.fs.pathExists(worktreePath)) return "stale-dir";
    return "absent";
  }

  async get(workspaceId: string): Promise<WorkspaceHandle | undefined> {
    const cached = this.handles.get(workspaceId);
    if (cached) {
      if (await this.probeWorktree(cached.path) !== "worktree") {
        this.handles.delete(workspaceId);
        return undefined;
      }
      return cached;
    }

    if (workspaceId.startsWith("existing-")) return undefined;

    if (!workspaceId.startsWith("ws-")) return undefined;

    const slug = workspaceId.slice(3);
    const worktreePath = join(this.workspaceRoot, slug);

    try {
      await this.validateContainment(worktreePath);
    } catch {
      return undefined;
    }

    if (await this.probeWorktree(worktreePath) !== "worktree") return undefined;

    let branch: string;
    try {
      const { stdout } = await this.gitClient.run(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      branch = stdout.trim();
    } catch {
      return undefined;
    }

    const handle: WorkspaceHandle = {
      workspaceId,
      mode: "worktree",
      path: worktreePath,
      containerPath: worktreePath,
      branch,
    };
    return handle;
  }

  async create(spec: WorkspaceCreateSpec): Promise<WorkspaceHandle> {
    const mode = spec.mode ?? "worktree";
    const wfSlug = slugify(spec.workflowId);
    const taskSlug = slugify(spec.taskId);

    if (!wfSlug || !taskSlug) {
      throw new WorkspaceError("path_escape", "workflowId and taskId must produce non-empty slugs", {
        workflowId: spec.workflowId,
        taskId: spec.taskId,
      });
    }

    if (mode === "existing") {
      const workspaceId = `existing-${wfSlug}_${taskSlug}`;
      const handle: WorkspaceHandle = {
        workspaceId,
        mode: "existing",
        path: this.repoPath,
        containerPath: this.repoPath,
        branch: spec.branch,
      };
      this.handles.set(workspaceId, handle);
      return handle;
    }

    const worktreePath = join(this.workspaceRoot, `${wfSlug}_${taskSlug}`);
    await this.validateContainment(worktreePath);

    const workspaceId = `ws-${wfSlug}_${taskSlug}`;

    return this.withLock(this.repoPath, async () => {
      const existingWorktree = await this.probeWorktree(worktreePath);

      if (existingWorktree === "worktree") {
        if (spec.resetBranch === true) {
          await this.gitClient.worktreeRemove(this.repoPath, worktreePath, { force: true });
          await this.gitClient.worktreePrune(this.repoPath);
          await this.fs.removeRecursive(worktreePath);
        } else {
          const handle: WorkspaceHandle = {
            workspaceId,
            mode: "worktree",
            path: worktreePath,
            containerPath: worktreePath,
            branch: spec.branch,
          };
          this.handles.set(workspaceId, handle);
          return handle;
        }
      } else if (existingWorktree === "stale-dir") {
        await this.fs.removeRecursive(worktreePath);
      }

      const addOpts: { path: string; branch: string; baseRef?: string; resetBranch?: boolean } = {
        path: worktreePath,
        branch: spec.branch,
      };
      if (spec.baseRef !== undefined) addOpts.baseRef = spec.baseRef;
      if (spec.resetBranch !== undefined) addOpts.resetBranch = spec.resetBranch;
      await this.gitClient.worktreeAdd(this.repoPath, addOpts);

      const handle: WorkspaceHandle = {
        workspaceId,
        mode: "worktree",
        path: worktreePath,
        containerPath: worktreePath,
        branch: spec.branch,
      };
      this.handles.set(workspaceId, handle);
      return handle;
    });
  }

  async cleanup(workspaceId: string): Promise<void> {
    if (workspaceId.startsWith("existing-")) {
      this.handles.delete(workspaceId);
      return;
    }

    if (!workspaceId.startsWith("ws-")) {
      return;
    }

    const slug = workspaceId.slice(3);
    const worktreePath = join(this.workspaceRoot, slug);

    try {
      await this.validateContainment(worktreePath);
    } catch {
      return;
    }

    await this.withLock(this.repoPath, async () => {
      try {
        await this.gitClient.worktreeRemove(this.repoPath, worktreePath, { force: true });
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }

      try {
        await this.gitClient.worktreePrune(this.repoPath);
      } catch {
        // prune failure is non-fatal; reclaimable via future sweep
      }

      try {
        await this.fs.removeRecursive(worktreePath);
      } catch {
        // non-fatal; directory may already be gone
      }
    });

    this.handles.delete(workspaceId);
  }
}
