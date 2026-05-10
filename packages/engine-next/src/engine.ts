import type { Hono } from "hono";
import { dirname, basename, join, isAbsolute, resolve, relative } from "node:path";
import { runBootRecovery } from "./application/boot.js";
import type { BootRecoveryReport, BootRespawnContext } from "./application/boot.js";
import type { SCMPlugin } from "./plugins/scm-plugin.js";
import type { PollCadence } from "./application/ci-babysitter-service.js";
import { applyCommand } from "./application/commands.js";
import { ContinueTaskService } from "./application/continue-task-service.js";
import { RetryTaskService } from "./application/retry-task-service.js";
import { createRecoveryService } from "./application/recovery-service.js";
import { NoopRestackExecutor } from "./application/restack-executor.js";
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
import { CIBabysitterService } from "./application/ci-babysitter-service.js";
import { QualityGateService } from "./application/quality-gate-service.js";
import { CompletionDispatcher } from "./application/completion-dispatcher.js";
import type { QualityPlugin } from "./plugins/quality-plugin.js";
import type { WorkflowEvent } from "./domain/events.js";
import { buildSinksFromEnv, type Sink } from "./observability/sinks.js";
import { createLogger, parseLevel, type Logger } from "./observability/logger.js";
import type { Level } from "./observability/types.js";
import { ObservabilityService } from "./observability/observability-service.js";
import { createSupervisor } from "./supervisor/supervisor.js";
import type { SupervisorWithRepos } from "./supervisor/supervisor.js";

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
  repoPath?: string;
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
  githubRepo?: { owner: string; repo: string };
  githubBaseBranch?: string;
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
  const executor = config.executor ?? new NoopRestackExecutor();
  const now = config.now ?? (() => new Date().toISOString());
  const staleReadyMs = config.staleReadyMs ?? 5 * 60 * 1000;
  const staleGateMs = config.staleGateMs ?? 30 * 60 * 1000;

  let workspace: WorkspaceBackend;
  let sharedGitClient: GitClient | undefined;
  if (config.workspace) {
    workspace = config.workspace;
  } else if (config.repoPath) {
    const gitCommandPrefix = config.gitCommandPrefix ?? [];
    sharedGitClient = new GitClient(gitCommandPrefix.length > 0 ? { commandPrefix: gitCommandPrefix } : {});
    const workspaceRoot = config.workspaceRoot ?? join(dirname(config.repoPath), `${basename(config.repoPath)}-worktrees`);
    workspace = await GitWorktreeWorkspaceBackend.create({
      gitClient: sharedGitClient,
      repoPath: config.repoPath,
      workspaceRoot,
      gitCommandPrefix,
    });
  } else {
    workspace = new StubWorkspaceBackend();
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
    const orch = new RunOrchestrator({ ...deps, signal: controller.signal, log: log.child({ component: "run-orchestrator", workflowId: deps.workflowId, taskId: deps.taskId }) });
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
    serverDeps.retryTaskService = new RetryTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: config.providerFactory,
      runtime,
      workspace,
      now,
      spawnOrchestrator: spawnTracked,
    });
  }

  let ciBabysitterAbort: AbortController | undefined;

  const githubToken = config.githubToken ?? process.env["MWF_GITHUB_TOKEN"];
  const scmOverride = config.scm;
  const ghClientOverride = config.githubClient;
  const githubEnabled = (githubToken && config.githubRepo) ||
                        (config.githubRepo && (scmOverride !== undefined || ghClientOverride !== undefined));

  if (githubEnabled && config.githubRepo) {
    if (workspace instanceof StubWorkspaceBackend) {
      throw new Error("github integration requires a real workspace backend (set repoPath)");
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
      repoCoords: config.githubRepo,
      baseBranch: config.githubBaseBranch ?? "main",
      now,
      log: log.child({ component: "merge" }),
    });

    if (config.providerFactory && serverDeps.continueTaskService && ghClient) {
      ciBabysitterAbort = new AbortController();
      const babysitterDeps: ConstructorParameters<typeof CIBabysitterService>[0] = {
        workflowRepo: repo,
        github: ghClient,
        repoCoords: config.githubRepo,
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
      observabilityAbort.abort();
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
