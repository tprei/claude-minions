import type { Hono } from "hono";
import { dirname, join, isAbsolute, resolve, relative } from "node:path";
import { statfs } from "node:fs/promises";
import { spawn } from "node:child_process";
import { PiProvider } from "./plugins/providers/pi.js";
import { runBootRecovery } from "./application/boot.js";
import type { BootRecoveryReport, BootRespawnContext } from "./application/boot.js";
import type { SCMPlugin } from "./plugins/scm-plugin.js";
import type { PollCadence } from "./application/ci-babysitter-service.js";
import { applyCommand } from "./application/commands.js";
import { ContinueTaskService } from "./application/continue-task-service.js";
import { RetryTaskService } from "./application/retry-task-service.js";
import { createRecoveryService } from "./application/recovery-service.js";
import { GitWorktreeRestackExecutor, NoopRestackExecutor } from "./application/restack-executor.js";
import type { RestackExecutor } from "./application/restack-executor.js";
import { RunOrchestrator } from "./application/run-orchestrator.js";
import type { RunOrchestratorDeps } from "./application/run-orchestrator.js";
import { PushService } from "./application/push-service.js";
import type { SubscriptionRepository } from "./application/subscription-repository.js";
import { SQLiteWorkflowRepository } from "./persistence/sqlite-repo.js";
import { SQLiteSubscriptionRepository, listDistinctWorkflowIds } from "./persistence/sqlite-subscription-repo.js";
import type { WorkflowRepository } from "./application/repository.js";
import type { ProviderPlugin } from "./plugins/provider-plugin.js";
import type { RuntimeBackend } from "./plugins/runtime-backend.js";
import { StubRuntimeBackend } from "./plugins/stub-runtime.js";
import { WebPushSender } from "./plugins/push-sender.js";
import type { PushSender, VapidConfig } from "./plugins/push-sender.js";
import type { WorkspaceBackend } from "./plugins/workspace-backend.js";
import { GitClient } from "./plugins/git/git-client.js";
import { GitWorktreeWorkspaceBackend } from "./plugins/workspace/git-worktree-backend.js";
import { StubWorkspaceBackend } from "./plugins/workspace/stub-workspace.js";
import { createServer } from "./transport/server.js";
import { TokenBucket } from "./plugins/github/rate-limiter.js";
import { GitHubClient } from "./plugins/github/github-client.js";
import { GitHubScmPlugin } from "./plugins/github/github-scm-plugin.js";
import { MergeService } from "./application/merge-service.js";
import { LandWorkflowService } from "./application/land-workflow-service.js";
import { LocalFinalizeService } from "./application/local-finalize-service.js";
import { CIBabysitterService } from "./application/ci-babysitter-service.js";
import { QualityGateService } from "./application/quality-gate-service.js";
import { CompletionDispatcher } from "./application/completion-dispatcher.js";
import { SchedulerService } from "./application/scheduler-service.js";
import { WorkflowPlannerService } from "./application/planner-service.js";
import type { QualityPlugin } from "./plugins/quality-plugin.js";
import type { WorkflowEvent } from "./domain/events.js";
import { buildSinksFromEnv, type Sink } from "./observability/sinks.js";
import { createLogger, parseLevel, type Logger } from "./observability/logger.js";
import type { Level } from "./observability/types.js";
import { ObservabilityService } from "./observability/observability-service.js";
import { createSupervisor } from "./supervisor/supervisor.js";
import type { SupervisorWithRepos } from "./supervisor/supervisor.js";
import { buildRepoRegistry, type RepoBindingInput, type RepoRegistry } from "./application/repo-registry.js";

export interface EngineConfig {
  dbPath: string;
  dataDir?: string;
  runtime?: RuntimeBackend;
  executor?: RestackExecutor;
  providerFactory?: () => ProviderPlugin;
  staleReadyMs?: number;
  staleGateMs?: number;
  now?: () => string;
  workspace?: WorkspaceBackend;
  repos: RepoBindingInput[];
  reposRoot?: string;
  workspaceRoot?: string;
  gitCommandPrefix?: readonly string[];
  vapid?: VapidConfig;
  pushSender?: PushSender;
  /**
   * Directory that contains the built PWA assets (index.html, sw.js, etc.).
   * Relative paths resolve against `process.cwd()` at engine startup.
   * `process.cwd()` MUST NOT change after the engine is created — the resolved
   * path is captured once and reused for every request.
   */
  pwaDir?: string;
  githubToken?: string;
  qualityPlugin?: QualityPlugin;
  qualityDefaultTimeoutMs?: number;
  log?: Logger;
  logLevel?: Level;
  logSinks?: Sink[];
  /** integration-test seam: bypass GitHubScmPlugin construction. */
  scm?: SCMPlugin;
  /** integration-test seam: bypass default GitHubClient construction. */
  githubClient?: GitHubClient;
  /** integration-test seam: override CIBabysitter polling cadence. */
  ciBabysitterCadence?: PollCadence;
  supervisor?: SupervisorWithRepos;
  scanIntervalMs?: number;
  recoveryScanIntervalMs?: number;
  providerName?: string;
  buildSha?: string;
  startedAt?: string;
}

const ENGINE_FEATURES = [
  "workflows",
  "workflow-planning",
  "task-transitions",
  "scheduler",
  "provider-orchestration",
  "transcripts",
  "recovery",
  "restack",
  "quality-gates",
  "github-prs",
  "ci-babysit",
  "local-finalize",
  "push",
  "supervisor",
  "audit",
  "observability",
  "pwa-connections",
  "snapshot-cache",
  "status-rendering",
  "slash-commands",
  "voice-input",
  "runtime-diagnostics",
] as const;

type DoctorStatus = "ok" | "degraded" | "error";

interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail?: string;
  checkedAt: string;
}

interface SubscriberCountRepo {
  subscriberCount(workflowId: string): number;
}

interface PragmasRepo {
  getPragmas(): { journalMode: string; busyTimeout: number; foreignKeys: number };
}

function resolveVapid(config: EngineConfig): VapidConfig | undefined {
  if (config.vapid) return config.vapid;
  const pub = process.env["MWF_VAPID_PUBLIC_KEY"];
  const priv = process.env["MWF_VAPID_PRIVATE_KEY"];
  const subject = process.env["MWF_VAPID_SUBJECT"];
  if (pub && priv && subject) {
    return { publicKey: pub, privateKey: priv, subject };
  }
  return undefined;
}

export interface Engine {
  server: Hono;
  bootReport: BootRecoveryReport;
  dataDir: string;
  repo: WorkflowRepository;
  close(): Promise<void>;
}

export async function createEngine(config: EngineConfig): Promise<Engine> {
  const startedAt = config.startedAt ?? new Date().toISOString();
  const buildSha = config.buildSha ?? process.env["MWF_BUILD_SHA"] ?? process.env["GITHUB_SHA"] ?? "unknown";
  const ownsSinks = config.log === undefined;
  const baseSinks: Sink[] = ownsSinks ? (config.logSinks ?? buildSinksFromEnv()) : [];

  const vapidEarly = resolveVapid(config);
  const repoEarly = new SQLiteWorkflowRepository(config.dbPath);
  const senderEarly: PushSender | undefined = vapidEarly
    ? (config.pushSender ?? new WebPushSender(vapidEarly))
    : undefined;

  const supervisor = config.supervisor ?? createSupervisor({
    db: repoEarly.getDatabase(),
    ...(senderEarly !== undefined ? { sender: senderEarly } : {}),
    ...(config.scanIntervalMs !== undefined ? { scanIntervalMs: config.scanIntervalMs } : {}),
  });

  // When config.log is provided, the caller manages sink composition; supervisor.sink
  // is not attached automatically. Audit projection and rule triggering require
  // either no config.log (engine builds its own logger including supervisor.sink)
  // or the caller including supervisor.sink in their logger's sink list explicitly.
  const sinks: Sink[] = ownsSinks ? [...baseSinks, supervisor.sink] : baseSinks;

  const log: Logger = config.log ?? createLogger(
    config.logLevel ?? parseLevel(process.env["MWF_LOG_LEVEL"]),
    sinks,
    { service: "engine" },
  );

  supervisor.attachLogger(log.child({ component: "supervisor" }));
  supervisor.attachRepo(repoEarly);
  supervisor.start();

  log.info("engine started", { kind: "engine-lifecycle", phase: "started", dbPath: config.dbPath });

  const dataDir = config.dataDir ?? `${dirname(config.dbPath)}/sessions`;
  const runtime = config.runtime ?? new StubRuntimeBackend();
  const now = config.now ?? (() => new Date().toISOString());
  const staleReadyMs = config.staleReadyMs ?? 5 * 60 * 1000;
  const staleGateMs = config.staleGateMs ?? 30 * 60 * 1000;

  const reposRoot = config.reposRoot ?? join(dataDir, "repos");
  const repoRegistry: RepoRegistry = buildRepoRegistry(config.repos, { reposRoot });
  const githubBackedBinding = repoRegistry.all().find((b) => b.github !== undefined);

  let workspace: WorkspaceBackend;
  let sharedGitClient: GitClient | undefined;
  if (config.workspace) {
    workspace = config.workspace;
  } else {
    const { existsSync } = await import("node:fs");
    const { rename, mkdir } = await import("node:fs/promises");

    // Legacy migration: data/repo → data/repos/<firstId>. Runs once when the new
    // layout dir is empty and the old single-clone exists.
    const firstBinding = repoRegistry.all()[0]!;
    const legacyRepoPath = join(dataDir, "repo");
    if (existsSync(legacyRepoPath) && !existsSync(firstBinding.localPath)) {
      await mkdir(reposRoot, { recursive: true });
      log.info("migrating legacy data/repo into data/repos/<id>", {
        from: legacyRepoPath,
        to: firstBinding.localPath,
        repoId: firstBinding.id,
      });
      await rename(legacyRepoPath, firstBinding.localPath);
    }

    // Clone any missing remotes. Skipped in tests (no remote configured).
    const githubToken = config.githubToken ?? process.env["MWF_GITHUB_TOKEN"];
    for (const binding of repoRegistry.all()) {
      if (existsSync(binding.localPath)) continue;
      if (!binding.remote) continue;
      const remoteUrl = githubToken && binding.remote.startsWith("https://github.com/")
        ? binding.remote.replace("https://github.com/", `https://x-access-token:${githubToken}@github.com/`)
        : binding.remote;
      await mkdir(reposRoot, { recursive: true });
      log.info("cloning bound repo", { repoId: binding.id, remote: binding.remote, localPath: binding.localPath });
      const tempClient = new GitClient();
      await tempClient.run(reposRoot, ["clone", "--filter=blob:none", remoteUrl, binding.localPath]);
    }

    const localExists = existsSync(firstBinding.localPath);
    const hasRemote = firstBinding.remote !== undefined;
    if (hasRemote || localExists) {
      const gitCommandPrefix = config.gitCommandPrefix ?? [];
      sharedGitClient = new GitClient(gitCommandPrefix.length > 0 ? { commandPrefix: gitCommandPrefix } : {});
      const workspaceRoot = config.workspaceRoot ?? `${firstBinding.localPath}-worktrees`;
      workspace = await GitWorktreeWorkspaceBackend.create({
        gitClient: sharedGitClient,
        repoPath: firstBinding.localPath,
        workspaceRoot,
        gitCommandPrefix,
        registry: repoRegistry,
        defaultRepoId: firstBinding.id,
      });
    } else {
      workspace = new StubWorkspaceBackend();
    }
  }

  let executor: RestackExecutor;
  if (config.executor !== undefined) {
    executor = config.executor;
  } else if (workspace instanceof GitWorktreeWorkspaceBackend && sharedGitClient !== undefined) {
    executor = new GitWorktreeRestackExecutor({ gitClient: sharedGitClient, workspace, now });
  } else {
    executor = new NoopRestackExecutor();
  }

  const vapid = vapidEarly;
  const repo = repoEarly;
  const recoveryService = createRecoveryService(repo, executor, runtime, now, log.child({ component: "recovery" }));

  type ActiveOrchestratorEntry = { controller: AbortController; promise: Promise<void> };
  const activeOrchestrators = new Set<ActiveOrchestratorEntry>();

  const spawnTracked = (deps: Omit<RunOrchestratorDeps, "signal" | "log">): void => {
    const controller = new AbortController();
    const entry: ActiveOrchestratorEntry = {
      controller,
      promise: undefined as unknown as Promise<void>,
    };
    activeOrchestrators.add(entry);
    const persistTranscript = deps.persistTranscript ?? ((occurredAt, providerEvent) =>
      repo.appendTranscript(deps.workflowId, deps.runId, occurredAt, providerEvent));
    const orch = new RunOrchestrator({ ...deps, persistTranscript, signal: controller.signal, log: log.child({ component: "run-orchestrator", workflowId: deps.workflowId, taskId: deps.taskId }) });
    entry.promise = orch
      .run()
      .catch((err) => log.child({ component: "run-orchestrator" }).error("run-orchestrator error", { error: (err as Error).message }))
      .finally(() => { activeOrchestrators.delete(entry); });
  };

  const bootSpawnOrchestrator = config.providerFactory
    ? (ctx: BootRespawnContext) => {
        const provider = config.providerFactory!();
        const deps: Omit<RunOrchestratorDeps, "signal" | "log"> = {
          workflowId: ctx.workflowId,
          taskId: ctx.taskId,
          runId: ctx.runId,
          runtimeSessionId: ctx.runtimeSessionId,
          provider,
          runtime,
          workspace,
          // workspaceId from task state; if absent the cleanup is a no-op (stub handles it)
          workspaceId: ctx.workspaceId ?? "",
          applyCommand: (cmd) => applyCommand(repo, cmd),
          publish: (providerEvent) => {
            const envelope: WorkflowEvent = {
              cursor: 0,
              workflowId: ctx.workflowId,
              occurredAt: now(),
              kind: "provider-event",
              payload: { taskId: ctx.taskId, runId: ctx.runId, providerEvent },
            };
            repo.publishTransient(ctx.workflowId, envelope);
          },
          persistTranscript: (occurredAt, providerEvent) =>
            repo.appendTranscript(ctx.workflowId, ctx.runId, occurredAt, providerEvent),
          now,
        };
        if (ctx.fromOffset !== undefined) deps.fromOffset = ctx.fromOffset;
        spawnTracked(deps);
      }
    : undefined;

  const bootRecoveryOpts: Parameters<typeof runBootRecovery>[3] = {
    now,
    staleReadyMs,
    staleGateMs,
  };
  if (bootSpawnOrchestrator !== undefined) bootRecoveryOpts.spawnOrchestrator = bootSpawnOrchestrator;

  const bootReport = await runBootRecovery(repo, recoveryService, runtime, bootRecoveryOpts);
  log.info("boot complete", { kind: "engine-lifecycle", phase: "boot-complete", report: bootReport });

  let pushAbort: AbortController | undefined;
  let pushService: PushService | undefined;
  let subscriptions: SubscriptionRepository | undefined;

  if (vapid) {
    pushAbort = new AbortController();
    const db = repo.getDatabase();
    subscriptions = new SQLiteSubscriptionRepository(db);
    const sender: PushSender = senderEarly!;
    pushService = new PushService({ workflowRepo: repo, subscriptions, sender, signal: pushAbort.signal, log: log.child({ component: "push" }) });

    const recoverableWorkflows = await repo.listRecoverable();
    const recoverableIds = new Set(recoverableWorkflows.map((w) => w.id));
    const subWorkflowIds = listDistinctWorkflowIds(db);
    const allAttach = new Set([...recoverableIds, ...subWorkflowIds]);
    for (const workflowId of allAttach) {
      pushService.attach(workflowId);
    }
  }

  let pwaRoot: string | undefined;
  const pwaDirRaw = config.pwaDir ?? process.env["MWF_PWA_DIR"];
  if (pwaDirRaw !== undefined) {
    const abs = isAbsolute(pwaDirRaw)
      ? pwaDirRaw
      : resolve(process.cwd(), pwaDirRaw);
    pwaRoot = relative(process.cwd(), abs);
  }

  const serverDeps: Parameters<typeof createServer>[0] = { repo, recoveryService, executor };

  if (vapid && pushService && subscriptions) {
    serverDeps.pushService = pushService;
    serverDeps.subscriptions = subscriptions;
    serverDeps.vapidPublicKey = vapid.publicKey;
  }

  if (pwaRoot !== undefined) {
    serverDeps.pwaRoot = pwaRoot;
  }

  let schedulerAbort: AbortController | undefined;

  if (config.providerFactory) {
    serverDeps.continueTaskService = new ContinueTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: config.providerFactory,
      runtime,
      workspace,
      now,
      spawnOrchestrator: spawnTracked,
    });
    const retryTaskService = new RetryTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: config.providerFactory,
      runtime,
      workspace,
      now,
      spawnOrchestrator: spawnTracked,
    });
    serverDeps.retryTaskService = retryTaskService;

    schedulerAbort = new AbortController();
    const schedulerService = new SchedulerService({
      repo,
      retry: retryTaskService,
      continueService: serverDeps.continueTaskService,
      log: log.child({ component: "scheduler" }),
      signal: schedulerAbort.signal,
    });

    const recoverableForScheduler = await repo.listRecoverable();
    for (const w of recoverableForScheduler) schedulerService.attach(w.id);
    serverDeps.schedulerService = schedulerService;
  }

  if (!process.env["MWF_PLANNER_DISABLED"]) {
    serverDeps.plannerService = new WorkflowPlannerService({
      log: log.child({ component: "planner" }),
      now,
    });
  }

  let ciBabysitterAbort: AbortController | undefined;

  const githubToken = config.githubToken ?? process.env["MWF_GITHUB_TOKEN"];
  const scmOverride = config.scm;
  const ghClientOverride = config.githubClient;
  const githubEnabled = Boolean((githubToken && githubBackedBinding) ||
                        (githubBackedBinding && (scmOverride !== undefined || ghClientOverride !== undefined)));

  if (githubEnabled && githubBackedBinding) {
    if (workspace instanceof StubWorkspaceBackend) {
      throw new Error("github integration requires a real workspace backend (configure repos[].localPath)");
    }
    const gitClient = sharedGitClient ?? new GitClient();

    let ghClient: GitHubClient | undefined;
    if (ghClientOverride !== undefined) {
      ghClient = ghClientOverride;
    } else if (githubToken) {
      const bucket = new TokenBucket({ capacity: 20, refillPerSec: 10 });
      ghClient = new GitHubClient({ token: githubToken, bucket, log: log.child({ component: "github-client" }) });
    }

    const scm: SCMPlugin = scmOverride
      ?? new GitHubScmPlugin({ github: ghClient!, git: gitClient, token: githubToken! });

    serverDeps.mergeService = new MergeService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      scm,
      workspace,
      repoRegistry,
      now,
      log: log.child({ component: "merge" }),
    });

    serverDeps.landWorkflowService = new LandWorkflowService({
      repo,
      mergeService: serverDeps.mergeService,
      log: log.child({ component: "land-workflow" }),
    });

    if (config.providerFactory && serverDeps.continueTaskService && ghClient) {
      ciBabysitterAbort = new AbortController();
      const babysitterDeps: ConstructorParameters<typeof CIBabysitterService>[0] = {
        workflowRepo: repo,
        github: ghClient,
        repoRegistry,
        applyCommand: (cmd) => applyCommand(repo, cmd),
        continueTaskService: serverDeps.continueTaskService,
        mergeService: serverDeps.mergeService,
        signal: ciBabysitterAbort.signal,
        now,
        log: log.child({ component: "ci-babysitter" }),
      };
      if (config.ciBabysitterCadence !== undefined) {
        babysitterDeps.cadence = config.ciBabysitterCadence;
      }
      const babysitter = new CIBabysitterService(babysitterDeps);
      serverDeps.ciBabysitter = babysitter;
      const recoverableWorkflows = await repo.listRecoverable();
      for (const w of recoverableWorkflows) babysitter.attach(w.id);
    }
  }

  let qualityAbort: AbortController | undefined;

  if (config.qualityPlugin) {
    qualityAbort = new AbortController();
    const qualityGateService = new QualityGateService({
      workflowRepo: repo,
      workspace,
      plugin: config.qualityPlugin,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      signal: qualityAbort.signal,
      now,
      log: log.child({ component: "quality-gate" }),
      ...(config.qualityDefaultTimeoutMs !== undefined ? { defaultTimeoutMs: config.qualityDefaultTimeoutMs } : {}),
    });
    serverDeps.qualityGateService = qualityGateService;
    const recoverableWorkflows = await repo.listRecoverable();
    const attachedIds = new Set<string>();
    for (const w of recoverableWorkflows) {
      qualityGateService.attach(w.id);
      attachedIds.add(w.id);
    }
    const allWorkflows = await repo.list({ includeCompleted: true });
    for (const w of allWorkflows) {
      if (!attachedIds.has(w.id) && Object.values(w.graph).some((t) => t.executionStatus === "completed")) {
        qualityGateService.attach(w.id);
      }
    }
  }

  let localFinalizeAbort: AbortController | undefined;

  if (!githubEnabled) {
    localFinalizeAbort = new AbortController();
    const localFinalizeDeps: ConstructorParameters<typeof LocalFinalizeService>[0] = {
      workflowRepo: repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      signal: localFinalizeAbort.signal,
      now,
      log: log.child({ component: "local-finalize" }),
    };
    if (sharedGitClient) {
      localFinalizeDeps.workspace = workspace;
      localFinalizeDeps.gitClient = sharedGitClient;
      localFinalizeDeps.repoRegistry = repoRegistry;
    }
    const localFinalizeService = new LocalFinalizeService(localFinalizeDeps);
    const recoverableWorkflows = await repo.listRecoverable();
    for (const w of recoverableWorkflows) localFinalizeService.attach(w.id);
    serverDeps.localFinalizeService = localFinalizeService;
  }

  let completionDispatcherAbort: AbortController | undefined;

  if (serverDeps.mergeService) {
    completionDispatcherAbort = new AbortController();
    const completionDispatcher = new CompletionDispatcher({
      workflowRepo: repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      mergeService: serverDeps.mergeService,
      signal: completionDispatcherAbort.signal,
      now,
      log: log.child({ component: "completion-dispatcher" }),
    });
    serverDeps.completionDispatcher = completionDispatcher;
    const recoverableWorkflows = await repo.listRecoverable();
    for (const w of recoverableWorkflows) completionDispatcher.attach(w.id);
  }

  const observabilityAbort = new AbortController();
  const observability = new ObservabilityService({
    workflowRepo: repo,
    log: log.child({ component: "observability" }),
    signal: observabilityAbort.signal,
  });
  const allWorkflows = await repo.list({ includeCompleted: true });
  for (const w of allWorkflows) observability.attach(w.id);
  serverDeps.observability = observability;
  serverDeps.log = log.child({ component: "transport" });
  serverDeps.supervisor = supervisor;
  serverDeps.versionInfo = () => ({
    apiVersion: "workflow-v1",
    libraryVersion: "0.1.0",
    buildSha,
    features: [...ENGINE_FEATURES],
    featuresPending: [],
    provider: config.providerName ?? process.env["MWF_PROVIDER"] ?? (config.providerFactory ? "configured" : "stub"),
    providers: ["claude-code", "codex", "pi", "stub"],
    repos: buildRepoBindings(repoRegistry),
    pluginSet: buildPluginSet({
      runtime,
      workspace,
      githubEnabled,
      qualityEnabled: config.qualityPlugin !== undefined,
      pushEnabled: vapid !== undefined,
    }),
    startedAt,
  });
  serverDeps.doctor = () => {
    const input: Parameters<typeof buildDoctorReport>[0] = {
      repo,
      dbPath: config.dbPath,
      dataDir,
      workspace,
      runtime,
      githubEnabled,
      githubTokenPresent: githubToken !== undefined,
      pushEnabled: vapid !== undefined,
      now,
    };
    const firstLocalPath = repoRegistry.all()[0]?.localPath;
    if (firstLocalPath !== undefined) input.repoPath = firstLocalPath;
    const providerName = config.providerName ?? process.env["MWF_PROVIDER"];
    if (providerName !== undefined) input.providerName = providerName.toLowerCase();
    return buildDoctorReport(input);
  };
  serverDeps.metrics = () => {
    const input: Parameters<typeof buildMetrics>[0] = { repo, supervisor, startedAt };
    if (serverDeps.schedulerService !== undefined) input.schedulerService = serverDeps.schedulerService;
    return buildMetrics(input);
  };

  let periodicRecoveryTimer: ReturnType<typeof setInterval> | undefined;
  let periodicRecoveryInFlight = false;
  const recoveryScanIntervalMs = config.recoveryScanIntervalMs ?? 5 * 60_000;
  if (recoveryScanIntervalMs > 0) {
    const recoveryLog = log.child({ component: "periodic-recovery" });
    periodicRecoveryTimer = setInterval(() => {
      if (periodicRecoveryInFlight) return;
      periodicRecoveryInFlight = true;
      void runBootRecovery(repo, recoveryService, runtime, {
        now,
        staleReadyMs,
        staleGateMs,
      }).then((report) => {
        recoveryLog.info("periodic recovery complete", { kind: "periodic-recovery", report });
      }).catch((err: unknown) => {
        recoveryLog.error("periodic recovery failed", { kind: "periodic-recovery", error: (err as Error).message });
      }).finally(() => {
        periodicRecoveryInFlight = false;
      });
    }, recoveryScanIntervalMs);
    periodicRecoveryTimer.unref?.();
  }

  const server = createServer(serverDeps);

  return {
    server,
    bootReport,
    dataDir,
    repo,
    async close() {
      log.info("engine shutdown", { kind: "engine-lifecycle", phase: "shutdown" });
      pushAbort?.abort();
      ciBabysitterAbort?.abort();
      qualityAbort?.abort();
      completionDispatcherAbort?.abort();
      localFinalizeAbort?.abort();
      schedulerAbort?.abort();
      observabilityAbort.abort();
      if (periodicRecoveryTimer !== undefined) clearInterval(periodicRecoveryTimer);
      for (const entry of activeOrchestrators) {
        entry.controller.abort();
      }
      await Promise.all([...activeOrchestrators].map((e) => e.promise));
      await supervisor.stop();
      repo.close();
      if (ownsSinks) await Promise.all(sinks.map((s) => s.close?.() ?? Promise.resolve()));
    },
  };
}

function buildRepoBindings(registry: RepoRegistry): Array<{ id: string; label: string; remote?: string; defaultBranch?: string }> {
  return registry.all().map((b) => {
    const out: { id: string; label: string; remote?: string; defaultBranch?: string } = {
      id: b.id,
      label: b.label,
      defaultBranch: b.defaultBranch,
    };
    if (b.remote !== undefined) out.remote = b.remote;
    return out;
  });
}

function buildPluginSet(input: {
  runtime: RuntimeBackend;
  workspace: WorkspaceBackend;
  githubEnabled: boolean;
  qualityEnabled: boolean;
  pushEnabled: boolean;
}): string[] {
  return [
    `runtime:${input.runtime.constructor.name}`,
    `workspace:${input.workspace.constructor.name}`,
    input.githubEnabled ? "scm:github" : "scm:local",
    input.qualityEnabled ? "quality:enabled" : "quality:disabled",
    input.pushEnabled ? "push:enabled" : "push:disabled",
  ];
}

interface PiProbeResult {
  status: DoctorStatus;
  detail: string;
}

const PI_VERSION_TIMEOUT_MS = 5000;
const PI_MIN_VERSION: readonly [number, number, number] = [0, 70, 0];

function compareSemver(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function parseSemver(text: string): [number, number, number] | undefined {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export async function defaultPiVersionProbe(): Promise<PiProbeResult> {
  return await new Promise<PiProbeResult>((resolvePromise) => {
    let stdout = "";
    let settled = false;
    const child = spawn("pi", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolvePromise({ status: "error", detail: `pi --version timed out after ${PI_VERSION_TIMEOUT_MS}ms` });
    }, PI_VERSION_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const detail = err.code === "ENOENT" ? "pi not on PATH" : err.message;
      resolvePromise({ status: "error", detail });
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolvePromise({ status: "error", detail: `pi --version exited with code ${code ?? "unknown"}` });
        return;
      }
      const version = parseSemver(stdout);
      if (version === undefined) {
        resolvePromise({ status: "error", detail: `could not parse semver from "${stdout.trim()}"` });
        return;
      }
      const detail = version.join(".");
      const status: DoctorStatus = compareSemver(version, PI_MIN_VERSION) >= 0 ? "ok" : "degraded";
      resolvePromise({ status, detail });
    });
  });
}

export async function defaultPiAuthProbe(): Promise<PiProbeResult> {
  const provider = new PiProvider();
  const result = await provider.loginStatus();
  if (result.details === "no auth.json") return { status: "error", detail: "no auth.json" };
  if (result.loggedIn) return { status: "ok", detail: result.details ?? "codex subscription present" };
  return { status: "degraded", detail: result.details ?? "no codex subscription" };
}

export async function buildDoctorReport(input: {
  repo: WorkflowRepository;
  dbPath: string;
  dataDir: string;
  repoPath?: string;
  workspace: WorkspaceBackend;
  runtime: RuntimeBackend;
  githubEnabled: boolean;
  githubTokenPresent: boolean;
  pushEnabled: boolean;
  now: () => string;
  providerName?: string;
  piVersionProbe?: () => Promise<PiProbeResult>;
  piAuthProbe?: () => Promise<PiProbeResult>;
}): Promise<{ status: DoctorStatus; checks: DoctorCheck[]; checkedAt: string }> {
  const checkedAt = input.now();
  const checks: DoctorCheck[] = [];
  const add = (check: Omit<DoctorCheck, "checkedAt">): void => {
    checks.push({ ...check, checkedAt });
  };

  const pragmas = hasPragmas(input.repo) ? input.repo.getPragmas() : undefined;
  add(pragmas?.journalMode.toLowerCase() === "wal"
    ? { name: "sqlite-wal", status: "ok", detail: "journal_mode=wal" }
    : { name: "sqlite-wal", status: "error", detail: `journal_mode=${pragmas?.journalMode ?? "unknown"}` });
  add(pragmas !== undefined && pragmas.busyTimeout >= 5000
    ? { name: "sqlite-busy-timeout", status: "ok", detail: `busy_timeout=${pragmas.busyTimeout}` }
    : { name: "sqlite-busy-timeout", status: "error", detail: `busy_timeout=${pragmas?.busyTimeout ?? "unknown"}` });

  add(input.repoPath !== undefined
    ? { name: "repo-state", status: "ok", detail: input.repoPath }
    : { name: "repo-state", status: "degraded", detail: "repoPath is not configured" });
  add(input.workspace.constructor.name === "GitWorktreeWorkspaceBackend"
    ? { name: "worktree-health", status: "ok", detail: "git worktree backend configured" }
    : { name: "worktree-health", status: "degraded", detail: input.workspace.constructor.name });
  add(input.runtime.constructor.name === "TmuxRuntimeBackend"
    ? { name: "tmux-runtime", status: "ok", detail: "tmux runtime configured" }
    : { name: "tmux-runtime", status: "degraded", detail: input.runtime.constructor.name });
  add(input.githubEnabled && input.githubTokenPresent
    ? { name: "github-auth", status: "ok", detail: "GitHub integration configured" }
    : { name: "github-auth", status: "degraded", detail: "GitHub integration is disabled" });
  add(input.pushEnabled
    ? { name: "push-config", status: "ok", detail: "VAPID configured" }
    : { name: "push-config", status: "degraded", detail: "VAPID is not configured" });
  add({ name: "dependency-cache", status: "degraded", detail: "no dependency cache is configured in the engine port" });

  try {
    const fs = await statfs(dirname(input.dbPath));
    const freeBytes = fs.bavail * fs.bsize;
    const threshold = 1024 * 1024 * 1024;
    add(freeBytes >= threshold
      ? { name: "disk-free", status: "ok", detail: `${freeBytes}` }
      : { name: "disk-free", status: "error", detail: `${freeBytes}` });
  } catch (err) {
    add({ name: "disk-free", status: "error", detail: (err as Error).message });
  }

  if (input.providerName === "pi") {
    const versionProbe = input.piVersionProbe ?? defaultPiVersionProbe;
    const authProbe = input.piAuthProbe ?? defaultPiAuthProbe;
    const [versionResult, authResult] = await Promise.all([
      versionProbe().catch((err: unknown) => ({ status: "error" as DoctorStatus, detail: (err as Error).message })),
      authProbe().catch((err: unknown) => ({ status: "error" as DoctorStatus, detail: (err as Error).message })),
    ]);
    add({ name: "pi-version", status: versionResult.status, detail: versionResult.detail });
    add({ name: "pi-auth", status: authResult.status, detail: authResult.detail });
  }

  const status: DoctorStatus = checks.some((check) => check.status === "error")
    ? "error"
    : checks.some((check) => check.status === "degraded")
      ? "degraded"
      : "ok";
  return { status, checks, checkedAt };
}

async function buildMetrics(input: {
  repo: WorkflowRepository;
  schedulerService?: SchedulerService;
  supervisor: SupervisorWithRepos;
  startedAt: string;
}): Promise<string> {
  const workflows = await input.repo.list({ includeCompleted: true });
  const recoverable = await input.repo.listRecoverable();
  const schedulerStats = input.schedulerService?.getStats() ?? { attachedWorkflows: 0, inFlight: 0 };
  let subscriberTotal = 0;
  if (hasSubscriberCount(input.repo)) {
    const subscriberRepo = input.repo;
    subscriberTotal = workflows.reduce((total, workflow) => total + subscriberRepo.subscriberCount(workflow.id), 0);
  }
  const alerts = input.supervisor.alertRepo.list({ limit: 500 });
  const lines: string[] = [
    "# HELP minions_workflows_total Workflows by status",
    "# TYPE minions_workflows_total gauge",
  ];
  const statusCounts = new Map<string, number>();
  for (const workflow of workflows) {
    statusCounts.set(workflow.status, (statusCounts.get(workflow.status) ?? 0) + 1);
  }
  for (const [status, count] of statusCounts) {
    lines.push(`minions_workflows_total{status=${quoteLabel(status)}} ${count}`);
  }
  lines.push("# HELP minions_recoverable_workflows Workflows eligible for recovery");
  lines.push("# TYPE minions_recoverable_workflows gauge");
  lines.push(`minions_recoverable_workflows ${recoverable.length}`);
  lines.push("# HELP minions_subscriber_hub_subscribers Active SSE subscribers");
  lines.push("# TYPE minions_subscriber_hub_subscribers gauge");
  lines.push(`minions_subscriber_hub_subscribers ${subscriberTotal}`);
  lines.push("# HELP minions_scheduler_in_flight In-flight scheduler dispatches");
  lines.push("# TYPE minions_scheduler_in_flight gauge");
  lines.push(`minions_scheduler_in_flight ${schedulerStats.inFlight}`);
  lines.push("# HELP minions_scheduler_attached_workflows Scheduler attached workflow count");
  lines.push("# TYPE minions_scheduler_attached_workflows gauge");
  lines.push(`minions_scheduler_attached_workflows ${schedulerStats.attachedWorkflows}`);
  lines.push("# HELP minions_alerts_total Alerts by kind and severity in the retained window");
  lines.push("# TYPE minions_alerts_total gauge");
  const alertCounts = new Map<string, number>();
  for (const alert of alerts) {
    const key = `${alert.kind}\u0000${alert.severity}`;
    alertCounts.set(key, (alertCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of alertCounts) {
    const [kind, severity] = key.split("\u0000");
    lines.push(`minions_alerts_total{kind=${quoteLabel(kind ?? "")},severity=${quoteLabel(severity ?? "")}} ${count}`);
  }
  lines.push("# HELP minions_engine_started_at_seconds Engine start time as Unix timestamp");
  lines.push("# TYPE minions_engine_started_at_seconds gauge");
  lines.push(`minions_engine_started_at_seconds ${Math.floor(Date.parse(input.startedAt) / 1000)}`);
  return `${lines.join("\n")}\n`;
}

function hasSubscriberCount(repo: WorkflowRepository): repo is WorkflowRepository & SubscriberCountRepo {
  return typeof (repo as Partial<SubscriberCountRepo>).subscriberCount === "function";
}

function hasPragmas(repo: WorkflowRepository): repo is WorkflowRepository & PragmasRepo {
  return typeof (repo as Partial<PragmasRepo>).getPragmas === "function";
}

function quoteLabel(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n")}"`;
}
