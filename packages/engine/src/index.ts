import path from "node:path";
import type { EngineContext } from "./context.js";
import type { EngineEnv } from "./env.js";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { openStore } from "./store/sqlite.js";
import { EventBus } from "./bus/eventBus.js";
import { KeyedMutex } from "./util/mutex.js";
import { RepoRepo } from "./store/repos/repoRepo.js";
import { buildHttpServer } from "./http/server.js";
import { registerRoutes } from "./http/routes/index.js";
import { attachSseRoute } from "./http/sse.js";
import { computeFeatureSets } from "./version/probes.js";
import { wireCompletionHandlers } from "./completion/handlers/index.js";
import type { SubsystemDeps } from "./wiring.js";

import { createAuditSubsystem } from "./audit/index.js";
import { createRuntimeSubsystem } from "./runtime/index.js";
import { createMemorySubsystem } from "./memory/index.js";
import { createResourceSubsystem } from "./resource/index.js";
import { createPushSubsystem } from "./push/index.js";
import { createLifecycleSubsystem } from "./lifecycle/index.js";
import { createDigestSubsystem } from "./digest/index.js";
import { createGithubSubsystem, type GithubSubsystemDeps } from "./github/index.js";
import { createQualitySubsystem } from "./quality/index.js";
import { createReadinessSubsystem } from "./readiness/index.js";
import { createIntakeSubsystem } from "./intake/index.js";
import { createSessionsSubsystem } from "./sessions/index.js";
import { createDagSubsystem } from "./dag/index.js";
import { DagRepo } from "./dag/model.js";
import { createShipSubsystem } from "./ship/index.js";
import { createLandingSubsystem } from "./landing/index.js";
import { createLoopsSubsystem } from "./loops/index.js";
import { createVariantsSubsystem } from "./variants/index.js";
import { createCiSubsystem } from "./ci/index.js";
import { createStatsSubsystem } from "./stats/index.js";
import { makeCleanupSubsystem } from "./cleanup/index.js";
import { workspacePaths } from "./workspace/paths.js";
import { clearMarker, readMarker, writeMarker } from "./lifecycle/marker.js";
import { runBootRecovery } from "./boot/recovery.js";
import { AutomationJobRepo } from "./store/repos/automationJobRepo.js";
import { createAutomationRunner } from "./automation/runner.js";
import type { JobHandler } from "./automation/types.js";

export async function createEngine(env: EngineEnv, log: Logger): Promise<EngineContext> {
  const engineLog = log ?? createLogger(env.logLevel, { service: "engine" });
  const previousMarker = readMarker(env.workspace);
  const db = openStore({ path: path.join(env.workspace, "engine.db"), log: engineLog });
  const bus = new EventBus();
  const mutex = new KeyedMutex();

  const repoRepo = new RepoRepo(db);
  const repoFile = RepoRepo.repoFilePath(env.workspace);
  const fileLoaded = repoRepo.loadFromFile(repoFile);
  if (fileLoaded) {
    engineLog.info("loaded repos from file", { repoFile });
  } else if (process.env["MINIONS_REPOS"]) {
    engineLog.warn("MINIONS_REPOS env is deprecated; move JSON to repos.json under MINIONS_WORKSPACE", { repoFile });
    repoRepo.loadFromEnv(process.env["MINIONS_REPOS"]);
  }

  const ctx = {} as EngineContext;
  ctx.env = env;
  ctx.log = engineLog;
  ctx.db = db;
  ctx.bus = bus;
  ctx.mutex = mutex;
  ctx.workspaceDir = env.workspace;
  ctx.previousMarker = previousMarker;

  const deps: SubsystemDeps = {
    ctx,
    log: engineLog,
    env,
    db,
    bus,
    mutex,
    workspaceDir: env.workspace,
  };

  const shutdownHooks: Array<() => Promise<void> | void> = [];

  function wire<T>(result: { api: T; onShutdown?: () => Promise<void> | void }): T {
    if (result.onShutdown) shutdownHooks.push(result.onShutdown);
    return result.api;
  }

  ctx.audit = wire(createAuditSubsystem(deps));
  ctx.runtime = wire(createRuntimeSubsystem(deps));
  ctx.memory = wire(createMemorySubsystem(deps));
  ctx.resource = wire(createResourceSubsystem(deps));
  ctx.push = wire(createPushSubsystem(deps));
  ctx.lifecycle = wire(createLifecycleSubsystem(deps));
  ctx.digest = wire(createDigestSubsystem(deps));
  const githubDeps: GithubSubsystemDeps = {
    db,
    log: engineLog,
    githubToken: process.env["GITHUB_TOKEN"] ?? null,
    appConfig: env.githubApp
      ? {
          appId: env.githubApp.id,
          privateKey: env.githubApp.privateKey,
          installationId: env.githubApp.installationId,
        }
      : null,
  };
  ctx.github = createGithubSubsystem(githubDeps);
  ctx.quality = wire(createQualitySubsystem(deps));
  ctx.readiness = wire(createReadinessSubsystem(deps));
  ctx.intake = wire(createIntakeSubsystem(deps));
  ctx.sessions = wire(createSessionsSubsystem(deps));
  ctx.dags = wire(createDagSubsystem(deps));
  ctx.ship = wire(createShipSubsystem(deps));
  ctx.landing = wire(createLandingSubsystem({ ...deps, dagRepo: new DagRepo(db, bus) }));
  ctx.loops = wire(createLoopsSubsystem(deps));
  ctx.variants = wire(createVariantsSubsystem(deps));
  ctx.ci = wire(createCiSubsystem(deps));
  ctx.stats = wire(createStatsSubsystem(deps));
  ctx.cleanup = makeCleanupSubsystem({
    sessions: ctx.sessions,
    audit: ctx.audit,
    workspaceDir: env.workspace,
    reposDir: workspacePaths(env.workspace).repos,
    worktreeRoot: env.workspace,
    log: engineLog,
    bus,
  });

  const unsubscribeCompletion = wireCompletionHandlers(ctx, engineLog);
  shutdownHooks.push(unsubscribeCompletion);

  const automationRepo = new AutomationJobRepo(db);
  const automationHandlers = new Map<string, JobHandler>();
  const automationRunner = createAutomationRunner({
    repo: automationRepo,
    ctx,
    log: engineLog.child({ component: "automation-runner" }),
    handlers: automationHandlers,
  });
  shutdownHooks.push(() => automationRunner.stop());

  let featuresReady: import("@minions/shared").FeatureFlag[] = [];
  let featuresPending: { flag: import("@minions/shared").FeatureFlag; reason: string }[] = [];
  ctx.features = () => featuresReady.slice();
  ctx.featuresPending = () => featuresPending.map((f) => ({ ...f }));
  ctx.repos = () => repoRepo.list();
  ctx.getRepo = (id: string) => repoRepo.get(id);

  const app = await buildHttpServer(ctx);
  await registerRoutes(app, ctx);
  attachSseRoute(app, ctx);

  const featureSets = await computeFeatureSets(ctx);
  featuresReady = featureSets.ready;
  featuresPending = featureSets.pending;

  await app.listen({ port: env.port, host: env.host });
  const addr = app.server.address();
  if (addr && typeof addr === "object") {
    env.port = addr.port;
  }

  writeMarker(env.workspace, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: env.libraryVersion,
  });

  ctx.shutdown = async () => {
    let listenerTimer: NodeJS.Timeout | undefined;
    try {
      app.server.closeAllConnections();
      await Promise.race([
        app.close(),
        new Promise<void>((_, reject) => {
          listenerTimer = setTimeout(
            () => reject(new Error("listener close timed out after 500ms")),
            500,
          );
        }),
      ]);
    } catch (e) {
      engineLog.warn("listener close did not complete cleanly", { message: (e as Error).message });
    } finally {
      if (listenerTimer) clearTimeout(listenerTimer);
    }

    let cleanupTimer: NodeJS.Timeout | undefined;
    const cleanup = (async () => {
      for (const hook of shutdownHooks.slice().reverse()) {
        try {
          await hook();
        } catch (e) {
          engineLog.error("shutdown hook error", { message: (e as Error).message });
        }
      }
    })();
    try {
      await Promise.race([
        cleanup,
        new Promise<void>((resolve) => {
          cleanupTimer = setTimeout(resolve, 300);
        }),
      ]);
    } finally {
      if (cleanupTimer) clearTimeout(cleanupTimer);
    }

    try {
      db.close();
    } catch (e) {
      engineLog.error("db close error", { message: (e as Error).message });
    }

    try {
      clearMarker(env.workspace);
    } catch (e) {
      engineLog.warn("marker clear failed", { message: (e as Error).message });
    }
  };
  engineLog.info("engine listening", { port: env.port, host: env.host });

  ctx.resource.start();
  await ctx.sessions.resumeAllActive();
  await ctx.ship.reconcileOnBoot();
  await runBootRecovery(ctx, db, engineLog);
  automationRunner.start();

  return ctx;
}
