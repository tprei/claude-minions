// Pipeline harness: creates a temp git repo + engine for integration tests.
// CountingWorkspaceBackend wraps the real backend to track create/cleanup calls per workspaceId.
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createEngine } from "../../src/engine.js";
import type { Engine, EngineConfig } from "../../src/engine.js";
import type { WorkspaceBackend, WorkspaceCreateSpec, WorkspaceHandle } from "../../src/plugins/workspace-backend.js";
import { GitWorktreeWorkspaceBackend } from "../../src/plugins/workspace/git-worktree-backend.js";
import { GitClient } from "../../src/plugins/git/git-client.js";
import type { SCMPlugin } from "../../src/plugins/scm-plugin.js";
import type { GitHubClient } from "../../src/plugins/github/github-client.js";
import type { PollCadence } from "../../src/application/ci-babysitter-service.js";
import { ExecQualityPlugin } from "../../src/plugins/quality/exec-quality-plugin.js";
import { HostCommandRunner } from "../../src/plugins/runners/host-command-runner.js";
import { silentLogger } from "../test-helpers.js";

const execFileAsync = promisify(execFile);

export interface HarnessOptions {
  withRealQuality?: boolean;
  qualityCommand?: "pass" | "fail";
  scm?: SCMPlugin;
  githubClient?: GitHubClient;
  ciBabysitterCadence?: PollCadence;
  providerFactory?: EngineConfig["providerFactory"];
  now?: () => string;
  baseDir?: string;
  dbPath?: string;
  repoPath?: string;
  workspaceRoot?: string;
}

export class CountingWorkspaceBackend implements WorkspaceBackend {
  readonly counts = {
    create: new Map<string, number>(),
    cleanupAttempts: new Map<string, number>(),
    cleanupSuccesses: new Map<string, number>(),
  };

  constructor(private readonly inner: WorkspaceBackend) {}

  async create(spec: WorkspaceCreateSpec): Promise<WorkspaceHandle> {
    const handle = await this.inner.create(spec);
    const k = handle.workspaceId;
    this.counts.create.set(k, (this.counts.create.get(k) ?? 0) + 1);
    return handle;
  }

  async get(id: string): Promise<WorkspaceHandle | undefined> {
    return this.inner.get(id);
  }

  async cleanup(id: string): Promise<void> {
    this.counts.cleanupAttempts.set(id, (this.counts.cleanupAttempts.get(id) ?? 0) + 1);
    await this.inner.cleanup(id);
    this.counts.cleanupSuccesses.set(id, (this.counts.cleanupSuccesses.get(id) ?? 0) + 1);
  }
}

export interface PipelineHarness {
  engine: Engine;
  dbPath: string;
  baseDir: string;
  repoPath: string;
  workspaceRoot: string;
  workspace: CountingWorkspaceBackend;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  cleanup: () => Promise<void>;
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<PipelineHarness> {
  const baseDir = opts.baseDir ?? await mkdtemp(join(tmpdir(), "mwf-pipeline-"));
  const repoPath = opts.repoPath ?? join(baseDir, "repo");
  const workspaceRoot = opts.workspaceRoot ?? join(baseDir, "workspaces");
  const dbPath = opts.dbPath ?? join(baseDir, "engine.db");

  await mkdir(repoPath, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });

  if (!opts.repoPath && !opts.baseDir) {
    await setupBareRepo(repoPath);
    if (opts.withRealQuality) await seedQualityConfig(repoPath, opts.qualityCommand ?? "pass");
  }

  const gitClient = new GitClient();
  const innerWorkspace = await GitWorktreeWorkspaceBackend.create({
    gitClient,
    repoPath,
    workspaceRoot,
  });
  const workspace = new CountingWorkspaceBackend(innerWorkspace);

  const config: EngineConfig = {
    dbPath,
    workspace,
    log: silentLogger(),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.scm !== undefined ? { scm: opts.scm, githubRepo: { owner: "fake", repo: "fake" } } : {}),
    ...(opts.githubClient !== undefined ? { githubClient: opts.githubClient } : {}),
    ...(opts.ciBabysitterCadence !== undefined ? { ciBabysitterCadence: opts.ciBabysitterCadence } : {}),
    ...(opts.providerFactory !== undefined ? { providerFactory: opts.providerFactory } : {}),
  };

  if (opts.withRealQuality) {
    config.qualityPlugin = new ExecQualityPlugin(new HostCommandRunner(), silentLogger());
    config.qualityDefaultTimeoutMs = 10_000;
  }

  const engine = await createEngine(config);

  const fetchHelper = async (path: string, init?: RequestInit): Promise<Response> => {
    const url = path.startsWith("http") ? path : `http://localhost${path}`;
    return engine.server.fetch(new Request(url, init));
  };

  const ownsBaseDir = opts.baseDir === undefined;
  const cleanup = async (): Promise<void> => {
    await engine.close();
    if (ownsBaseDir) await rm(baseDir, { recursive: true, force: true });
  };

  return { engine, dbPath, baseDir, repoPath, workspaceRoot, workspace, fetch: fetchHelper, cleanup };
}

export async function setupBareRepo(repoPath: string): Promise<void> {
  await execFileAsync("git", ["-C", repoPath, "init", "--initial-branch=main"]);
  await execFileAsync("git", ["-C", repoPath, "config", "user.email", "test@test.com"]);
  await execFileAsync("git", ["-C", repoPath, "config", "user.name", "Test"]);
  await execFileAsync("git", ["-C", repoPath, "commit", "--allow-empty", "-m", "init"]);
}

export async function seedQualityConfig(repoPath: string, kind: "pass" | "fail"): Promise<void> {
  const dotMinions = join(repoPath, ".minions");
  await mkdir(dotMinions, { recursive: true });
  const exit = kind === "pass" ? 0 : 1;
  const config = [{ name: "smoke", command: `node -e "process.exit(${exit})"`, required: true, timeoutMs: 5000 }];
  await writeFile(join(dotMinions, "quality.json"), JSON.stringify(config, null, 2));
  await execFileAsync("git", ["-C", repoPath, "add", ".minions/quality.json"]);
  await execFileAsync("git", ["-C", repoPath, "commit", "-m", "seed quality config"]);
}

export async function assertNoStrandedWorktrees(repoPath: string): Promise<void> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
  const lines = stdout.trim().split("\n").filter((l) => l.startsWith("worktree "));
  if (lines.length > 1) {
    throw new Error(`Stranded worktrees detected:\n${stdout}`);
  }
}
