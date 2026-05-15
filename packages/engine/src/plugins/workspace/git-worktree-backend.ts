import { join, sep, dirname, basename } from "node:path";
import { realpath, mkdir, symlink, access, readdir } from "node:fs/promises";
import type { GitClient } from "../git/git-client.js";
import { GitError } from "../git/git-client.js";
import type { WorkspaceBackend, WorkspaceCreateSpec, WorkspaceHandle } from "../workspace-backend.js";
import { WorkspaceError, slugify } from "../workspace-backend.js";
import type { WorkspaceFs } from "./workspace-fs.js";
import { HostFs, DockerFs } from "./workspace-fs.js";
import type { RepoRegistry } from "../../application/repo-registry.js";

export interface GitWorktreeBackendConfig {
  gitClient: GitClient;
  repoPath: string;
  workspaceRoot: string;
  gitCommandPrefix?: readonly string[];
  operationTimeoutMs?: number;
  registry?: RepoRegistry;
  defaultRepoId?: string;
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
  private static readonly DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
  private static readonly locks: Map<string, Promise<void>> = new Map();

  private readonly gitClient: GitClient;
  private readonly workspaceRoot: string;
  private readonly fs: WorkspaceFs;
  private readonly dockerMode: boolean;
  private readonly operationTimeoutMs: number;
  private readonly handles: Map<string, WorkspaceHandle> = new Map();
  private readonly registry: RepoRegistry | undefined;
  private readonly defaultRepoId: string;

  private repoPath: string;

  private constructor(
    gitClient: GitClient,
    repoPath: string,
    workspaceRoot: string,
    fs: WorkspaceFs,
    dockerMode: boolean,
    operationTimeoutMs: number,
    registry: RepoRegistry | undefined,
    defaultRepoId: string,
  ) {
    this.gitClient = gitClient;
    this.repoPath = repoPath;
    this.workspaceRoot = workspaceRoot;
    this.fs = fs;
    this.dockerMode = dockerMode;
    this.operationTimeoutMs = operationTimeoutMs;
    this.registry = registry;
    this.defaultRepoId = defaultRepoId;
  }

  private resolveRepoPath(repoId: string): string {
    if (!this.registry) return this.repoPath;
    const binding = this.registry.get(repoId);
    if (!binding) {
      throw new WorkspaceError("not_found", `unknown repoId ${repoId}`, { repoId });
    }
    return binding.localPath;
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

    const defaultRepoId = config.defaultRepoId ?? (config.registry?.all()[0]?.id ?? "");

    return new GitWorktreeWorkspaceBackend(
      config.gitClient,
      repoPath,
      workspaceRoot,
      fs,
      dockerMode,
      config.operationTimeoutMs ?? GitWorktreeWorkspaceBackend.DEFAULT_OPERATION_TIMEOUT_MS,
      config.registry,
      defaultRepoId,
    );
  }

  private async validateContainment(candidate: string): Promise<void> {
    // Multi-repo layout adds a `<repoSlug>/` segment between workspaceRoot and the
    // per-task dir, so 2 levels deep is legal when a registry is configured. The
    // single-repo legacy path keeps the original 1-level constraint.
    const maxDepth = this.registry !== undefined ? 2 : 1;

    if (this.dockerMode) {
      // In docker mode the host cannot realpath container-internal paths.
      // Validate structurally against workspaceRoot.
      if (!candidate.startsWith(this.workspaceRoot + sep)) {
        throw new WorkspaceError("path_escape", `candidate path escapes workspace root`, {
          candidate,
          workspaceRoot: this.workspaceRoot,
        });
      }
      const relative = candidate.slice(this.workspaceRoot.length + 1);
      if (relative === "" || relative === "." || relative === "..") {
        throw new WorkspaceError("path_escape", `workspace path must not be empty`, { candidate });
      }
      const depth = relative.split(sep).length;
      if (depth > maxDepth) {
        throw new WorkspaceError("path_escape", `workspace path exceeds max depth (${maxDepth})`, {
          candidate,
          depth,
        });
      }
      return;
    }

    // For multi-repo, the parent (repoSlug subdir) may not exist yet — create it.
    if (this.registry !== undefined) {
      try {
        await access(dirname(candidate));
      } catch {
        await mkdir(dirname(candidate), { recursive: true });
      }
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
    const depth = relative === "" ? 0 : relative.split(sep).length;
    if (depth > maxDepth) {
      throw new WorkspaceError("path_escape", `workspace path exceeds max depth (${maxDepth})`, {
        candidate,
        depth,
      });
    }
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const locks = GitWorktreeWorkspaceBackend.locks;
    const prev = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const current = prev.catch(() => undefined).then(() => gate);
    locks.set(key, current);

    await prev.catch(() => undefined);
    try {
      return await this.withOperationTimeout(fn());
    } finally {
      release();
      if (locks.get(key) === current) locks.delete(key);
    }
  }

  private withOperationTimeout<T>(promise: Promise<T>): Promise<T> {
    if (this.operationTimeoutMs <= 0) return promise;
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new WorkspaceError("lock_timeout", "workspace operation timed out", {
            repoPath: this.repoPath,
            timeoutMs: this.operationTimeoutMs,
          }));
        }, this.operationTimeoutMs);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  private async probeWorktree(worktreePath: string): Promise<"worktree" | "stale-dir" | "absent"> {
    if (await this.fs.gitMarkerExists(worktreePath)) return "worktree";
    if (await this.fs.pathExists(worktreePath)) return "stale-dir";
    return "absent";
  }

  private parseWorkspaceId(workspaceId: string): { repoId: string; tail: string } | undefined {
    if (!workspaceId.startsWith("ws-")) return undefined;
    const rest = workspaceId.slice(3);
    const sepIdx = rest.indexOf("--");
    if (sepIdx === -1) {
      // legacy format without repoId encoded; fall back to default
      return { repoId: this.defaultRepoId, tail: rest };
    }
    return { repoId: rest.slice(0, sepIdx), tail: rest.slice(sepIdx + 2) };
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

    const parsed = this.parseWorkspaceId(workspaceId);
    if (!parsed) return undefined;

    const isMultiRepoFormat = workspaceId.includes("--");
    const worktreePath = this.registry && isMultiRepoFormat
      ? join(this.workspaceRoot, slugify(parsed.repoId), parsed.tail)
      : join(this.workspaceRoot, parsed.tail);

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
      repoId: parsed.repoId,
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
    const repoSlug = slugify(spec.repoId);

    if (!wfSlug || !taskSlug || !repoSlug) {
      throw new WorkspaceError("path_escape", "workflowId, taskId, and repoId must produce non-empty slugs", {
        workflowId: spec.workflowId,
        taskId: spec.taskId,
        repoId: spec.repoId,
      });
    }

    const repoPath = this.resolveRepoPath(spec.repoId);

    if (mode === "existing") {
      const workspaceId = this.registry
        ? `existing-${repoSlug}--${wfSlug}_${taskSlug}`
        : `existing-${wfSlug}_${taskSlug}`;
      const handle: WorkspaceHandle = {
        workspaceId,
        repoId: spec.repoId,
        mode: "existing",
        path: repoPath,
        containerPath: repoPath,
        branch: spec.branch,
      };
      this.handles.set(workspaceId, handle);
      return handle;
    }

    const worktreePath = this.registry
      ? join(this.workspaceRoot, repoSlug, `${wfSlug}_${taskSlug}`)
      : join(this.workspaceRoot, `${wfSlug}_${taskSlug}`);
    await this.validateContainment(worktreePath);

    const workspaceId = this.registry
      ? `ws-${repoSlug}--${wfSlug}_${taskSlug}`
      : `ws-${wfSlug}_${taskSlug}`;

    return this.withLock(repoPath, async () => {
      const existingWorktree = await this.probeWorktree(worktreePath);

      if (existingWorktree === "worktree") {
        if (spec.resetBranch === true) {
          await this.gitClient.worktreeRemove(repoPath, worktreePath, { force: true });
          await this.gitClient.worktreePrune(repoPath);
          await this.fs.removeRecursive(worktreePath);
        } else {
          const handle: WorkspaceHandle = {
            workspaceId,
            repoId: spec.repoId,
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

      if (this.registry && !this.dockerMode) {
        const parentDir = dirname(worktreePath);
        try {
          await access(parentDir);
        } catch {
          await mkdir(parentDir, { recursive: true });
        }
      }

      const addOpts: { path: string; branch: string; baseRef?: string; resetBranch?: boolean } = {
        path: worktreePath,
        branch: spec.branch,
      };
      if (spec.baseRef !== undefined) addOpts.baseRef = spec.baseRef;
      if (spec.resetBranch !== undefined) addOpts.resetBranch = spec.resetBranch;
      await this.gitClient.worktreeAdd(repoPath, addOpts);

      await this.seedNodeModules(worktreePath, repoPath);

      const handle: WorkspaceHandle = {
        workspaceId,
        repoId: spec.repoId,
        mode: "worktree",
        path: worktreePath,
        containerPath: worktreePath,
        branch: spec.branch,
      };
      this.handles.set(workspaceId, handle);
      return handle;
    });
  }

  // Seed a fresh worktree with node_modules by symlinking the source repo's installs.
  // Chosen over a fresh `pnpm install` because pnpm's per-package node_modules contain
  // relative symlinks into the root .pnpm store; an absolute symlink at each node_modules
  // boundary preserves those relatives and avoids re-downloading/re-linking the universe.
  private async seedNodeModules(worktreePath: string, sourceRepoPath: string): Promise<void> {
    if (this.dockerMode) return; // operator handles container-side setup

    await this.linkNodeModules(sourceRepoPath, worktreePath);

    const packagesDir = join(sourceRepoPath, "packages");
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await readdir(packagesDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const srcPkg = join(packagesDir, entry.name);
      const dstPkg = join(worktreePath, "packages", entry.name);
      try {
        await access(dstPkg);
      } catch {
        continue; // worktree branch may not include this package
      }
      await this.linkNodeModules(srcPkg, dstPkg);
    }
  }

  private async linkNodeModules(srcDir: string, dstDir: string): Promise<void> {
    const srcNm = join(srcDir, "node_modules");
    const dstNm = join(dstDir, "node_modules");
    try {
      await access(srcNm);
    } catch {
      return;
    }
    try {
      await symlink(srcNm, dstNm, "dir");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  async cleanup(workspaceId: string): Promise<void> {
    if (workspaceId.startsWith("existing-")) {
      this.handles.delete(workspaceId);
      return;
    }

    const parsed = this.parseWorkspaceId(workspaceId);
    if (!parsed) return;

    const repoPath = this.resolveRepoPath(parsed.repoId);
    const isMultiRepoFormat = workspaceId.includes("--");
    const worktreePath = this.registry && isMultiRepoFormat
      ? join(this.workspaceRoot, slugify(parsed.repoId), parsed.tail)
      : join(this.workspaceRoot, parsed.tail);

    try {
      await this.validateContainment(worktreePath);
    } catch {
      return;
    }

    await this.withLock(repoPath, async () => {
      try {
        await this.gitClient.worktreeRemove(repoPath, worktreePath, { force: true });
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }

      try {
        await this.gitClient.worktreePrune(repoPath);
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
