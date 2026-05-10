import { serve } from "@hono/node-server";
import { ClaudeCodeProvider } from "./plugins/providers/claude-code.js";
import { CodexProvider } from "./plugins/providers/codex.js";
import { TmuxRuntimeBackend } from "./plugins/tmux/tmux-runtime.js";
import { ExecQualityPlugin } from "./plugins/quality/exec-quality-plugin.js";
import { HostCommandRunner } from "./plugins/runners/host-command-runner.js";
import { DockerCommandRunner } from "./plugins/runners/docker-command-runner.js";
import { createEngine, type EngineConfig } from "./engine.js";
import { parseLevel } from "./observability/logger.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

async function main(): Promise<void> {
  const port = Number(process.env["MWF_PORT"] ?? "3000");
  const dbPath = required("MWF_DB_PATH");
  const repoPath = optional("MWF_REPO_PATH");
  const workspaceRoot = optional("MWF_WORKSPACE_ROOT");
  const dataDir = optional("MWF_DATA_DIR");
  const pwaDir = optional("MWF_PWA_DIR");

  const dockerContainer = optional("MWF_DOCKER_CONTAINER");
  const dockerCommandPrefix = dockerContainer ? ["docker", "exec", dockerContainer] : undefined;
  const runner = dockerContainer ? new DockerCommandRunner(["docker", "exec", dockerContainer]) : new HostCommandRunner();

  const providerName = (process.env["MWF_PROVIDER"] ?? "claude-code").toLowerCase();
  const providerFactory = providerName === "codex"
    ? () => new CodexProvider()
    : () => new ClaudeCodeProvider();

  const githubToken = optional("MWF_GITHUB_TOKEN");
  const githubOwner = optional("MWF_GITHUB_REPO_OWNER");
  const githubRepoName = optional("MWF_GITHUB_REPO_NAME");
  const githubBaseBranch = optional("MWF_GITHUB_BASE_BRANCH");

  const vapidPublic = optional("MWF_VAPID_PUBLIC_KEY");
  const vapidPrivate = optional("MWF_VAPID_PRIVATE_KEY");
  const vapidSubject = optional("MWF_VAPID_SUBJECT");

  const config: EngineConfig = {
    dbPath,
    providerFactory,
    qualityPlugin: new ExecQualityPlugin(runner),
    logLevel: parseLevel(process.env["MWF_LOG_LEVEL"]),
  };

  if (repoPath !== undefined) config.repoPath = repoPath;
  if (workspaceRoot !== undefined) config.workspaceRoot = workspaceRoot;
  if (dataDir !== undefined) config.dataDir = dataDir;
  if (pwaDir !== undefined) config.pwaDir = pwaDir;
  if (dockerCommandPrefix !== undefined) config.gitCommandPrefix = dockerCommandPrefix;

  if (dataDir !== undefined || dockerContainer !== undefined) {
    const tmuxConfig: ConstructorParameters<typeof TmuxRuntimeBackend>[0] = {
      dataDir: dataDir ?? "/var/lib/minions",
    };
    if (dockerContainer !== undefined) {
      tmuxConfig.workerSessionsDir = process.env["MWF_DOCKER_WORKER_SESSIONS_DIR"] ?? "/sessions";
      tmuxConfig.commandPrefix = ["docker", "exec", dockerContainer];
    }
    config.runtime = new TmuxRuntimeBackend(tmuxConfig);
  }

  if (githubToken !== undefined && githubOwner !== undefined && githubRepoName !== undefined) {
    config.githubToken = githubToken;
    config.githubRepo = { owner: githubOwner, repo: githubRepoName };
    if (githubBaseBranch !== undefined) config.githubBaseBranch = githubBaseBranch;
  }

  if (vapidPublic !== undefined && vapidPrivate !== undefined && vapidSubject !== undefined) {
    config.vapid = { publicKey: vapidPublic, privateKey: vapidPrivate, subject: vapidSubject };
  }

  const engine = await createEngine(config);

  const httpServer = serve({ fetch: engine.server.fetch, port }, (info) => {
    console.log(`minions-engine listening on http://0.0.0.0:${info.port}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`received ${signal}, shutting down`);
    httpServer.close();
    await engine.close();
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
}

main().catch((err) => {
  console.error("engine failed to start:", err);
  process.exit(1);
});
