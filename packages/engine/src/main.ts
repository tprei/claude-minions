import { serve } from "@hono/node-server";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeProvider } from "./plugins/providers/claude-code.js";
import { CodexProvider } from "./plugins/providers/codex.js";
import { PiProvider, type PiProviderConfig } from "./plugins/providers/pi.js";
import { TmuxRuntimeBackend } from "./plugins/tmux/tmux-runtime.js";
import { ExecQualityPlugin } from "./plugins/quality/exec-quality-plugin.js";
import { StubQualityPlugin } from "./plugins/quality/stub-quality-plugin.js";
import { HostCommandRunner } from "./plugins/runners/host-command-runner.js";
import { DockerCommandRunner } from "./plugins/runners/docker-command-runner.js";
import { createEngine, type EngineConfig } from "./engine.js";
import type { RepoBindingInput } from "./application/repo-registry.js";
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

const PI_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function buildPiProviderFactory(): () => PiProvider {
  const model = optional("MWF_PI_MODEL") ?? "openai-codex/gpt-5.5";
  const reasoning = optional("MWF_PI_REASONING") ?? "xhigh";
  if (!(PI_REASONING_LEVELS as readonly string[]).includes(reasoning)) {
    throw new Error(
      `invalid MWF_PI_REASONING="${reasoning}"; must be one of ${PI_REASONING_LEVELS.join("|")}`,
    );
  }
  const agentDir = optional("MWF_PI_AGENT_DIR") ?? join(homedir(), ".pi", "agent");
  const sessionDir = optional("MWF_PI_SESSION_DIR") ?? join(agentDir, "sessions", "minions");
  const toolsAllowlist = optional("MWF_PI_TOOLS");

  const config: PiProviderConfig = { model, reasoning, agentDir, sessionDir };
  if (toolsAllowlist !== undefined) config.toolsAllowlist = toolsAllowlist;

  return () => new PiProvider(config);
}

async function loadReposJson(path: string): Promise<RepoBindingInput[]> {
  const { readFile } = await import("node:fs/promises");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`failed to read repos file at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`repos file at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`repos file at ${path} must contain a JSON array`);
  }
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || typeof (entry as { id?: unknown }).id !== "string") {
      throw new Error(`repos file at ${path} contains malformed entry: ${JSON.stringify(entry)}`);
    }
  }
  return parsed as RepoBindingInput[];
}

async function main(): Promise<void> {
  const port = Number(process.env["MWF_PORT"] ?? "3000");
  const dbPath = required("MWF_DB_PATH");
  const authToken = required("MWF_TOKEN");
  const siteTokenAuth = process.env["MWF_SITE_TOKEN_AUTH"] === "1";
  const workspaceRoot = optional("MWF_WORKSPACE_ROOT");
  const dataDir = optional("MWF_DATA_DIR");
  const pwaDir = optional("MWF_PWA_DIR");
  const reposRoot = optional("MWF_REPOS_ROOT");
  const reposFile = optional("MWF_REPOS_FILE") ?? (workspaceRoot ? join(workspaceRoot, "repos.json") : undefined);
  if (!reposFile) {
    throw new Error("MWF_REPOS_FILE or MWF_WORKSPACE_ROOT (with repos.json inside) must be set");
  }
  const repos = await loadReposJson(reposFile);

  const dockerContainer = optional("MWF_DOCKER_CONTAINER");
  const dockerCommandPrefix = dockerContainer ? ["docker", "exec", dockerContainer] : undefined;
  const runner = dockerContainer ? new DockerCommandRunner(["docker", "exec", dockerContainer]) : new HostCommandRunner();

  const providerName = (process.env["MWF_PROVIDER"] ?? "claude-code").toLowerCase();
  const providerFactory = providerName === "codex"
    ? () => new CodexProvider()
    : providerName === "pi"
      ? buildPiProviderFactory()
      : () => new ClaudeCodeProvider();

  const githubToken = optional("MWF_GITHUB_TOKEN");

  const vapidPublic = optional("MWF_VAPID_PUBLIC_KEY");
  const vapidPrivate = optional("MWF_VAPID_PRIVATE_KEY");
  const vapidSubject = optional("MWF_VAPID_SUBJECT");

  const qualityDisabled = process.env["MWF_QUALITY_DISABLED"] === "1";
  const recoveryScanIntervalRaw = optional("MWF_RECOVERY_SCAN_INTERVAL_MS");
  const runtimeIdleTimeoutRaw = optional("MWF_RUNTIME_IDLE_TIMEOUT_MS");
  const buildSha = optional("MWF_BUILD_SHA") ?? optional("GITHUB_SHA");
  const config: EngineConfig = {
    dbPath,
    repos,
    providerFactory,
    providerName,
    authToken,
    siteTokenAuth,
    qualityPlugin: qualityDisabled ? new StubQualityPlugin() : new ExecQualityPlugin(runner),
    logLevel: parseLevel(process.env["MWF_LOG_LEVEL"]),
  };
  if (buildSha !== undefined) config.buildSha = buildSha;
  if (recoveryScanIntervalRaw !== undefined) config.recoveryScanIntervalMs = Number(recoveryScanIntervalRaw);

  if (workspaceRoot !== undefined) config.workspaceRoot = workspaceRoot;
  if (reposRoot !== undefined) config.reposRoot = reposRoot;
  if (dataDir !== undefined) config.dataDir = dataDir;
  if (pwaDir !== undefined) config.pwaDir = pwaDir;
  if (dockerCommandPrefix !== undefined) config.gitCommandPrefix = dockerCommandPrefix;

  if (dataDir !== undefined || dockerContainer !== undefined) {
    const tmuxConfig: ConstructorParameters<typeof TmuxRuntimeBackend>[0] = {
      dataDir: dataDir ?? "/var/lib/minions",
    };
    if (runtimeIdleTimeoutRaw !== undefined) tmuxConfig.idleTimeoutMs = Number(runtimeIdleTimeoutRaw);
    if (dockerContainer !== undefined) {
      tmuxConfig.workerSessionsDir = process.env["MWF_DOCKER_WORKER_SESSIONS_DIR"] ?? "/sessions";
      tmuxConfig.commandPrefix = ["docker", "exec", dockerContainer];
    }
    config.runtime = new TmuxRuntimeBackend(tmuxConfig);
  }

  if (githubToken !== undefined) config.githubToken = githubToken;

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
