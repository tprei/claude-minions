import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";
import type { DoctorCheck, DoctorCheckName, FeatureFlag } from "@minions/shared";
import type { EngineContext } from "../context.js";
import { findClaudeBinary } from "../providers/claudeCode.js";
import { assertBridgeEntry } from "../memory/mcpServer.js";
import { gitAuthEnv } from "../ci/askpass.js";
import { parseGithubRemote } from "../github/parseRemote.js";

const execFileAsync = promisify(execFile);

export type ProbeResult = { ready: true } | { ready: false; reason: string };
export type FeatureProbe = (ctx: EngineContext) => ProbeResult | Promise<ProbeResult>;

const READY: ProbeResult = { ready: true };
const pending = (reason: string): ProbeResult => ({ ready: false, reason });

export const MEMORY_MCP_PROBE_TIMEOUT_MS = 2000;

export async function probeMemoryMcpBridge(
  bridgePath: string | null,
  timeoutMs = MEMORY_MCP_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const assertion = assertBridgeEntry(bridgePath);
  if (!assertion.ok || !assertion.path) {
    return pending(assertion.reason ?? "memory MCP bridge script not found");
  }

  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = spawn(process.execPath, [assertion.path], {
      env: { ...process.env, MINIONS_PROBE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return pending(`bridge spawn failed: ${(err as Error).message}`);
  }

  const cleanup = (): void => {
    try {
      if (child && !child.killed) child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };

  try {
    if (!child.stdin || !child.stdout) {
      return pending("bridge spawn produced no stdio pipes");
    }
    const rl = readline.createInterface({ input: child.stdout });
    const lineP = new Promise<string>((resolve, reject) => {
      rl.once("line", (l) => resolve(l));
      child!.once("error", (err) => reject(err));
      child!.once("exit", (code, signal) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`bridge exited with code ${code}`));
        } else if (signal) {
          reject(new Error(`bridge killed by signal ${signal}`));
        }
      });
    });

    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    child.stdin.write(request + "\n");

    let timer: NodeJS.Timeout | undefined;
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`tools/list timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    let line: string;
    try {
      line = await Promise.race([lineP, timeoutP]);
    } finally {
      if (timer) clearTimeout(timer);
      rl.close();
    }

    let parsed: { result?: { tools?: { name?: string }[] }; error?: { code: number; message: string } };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch (err) {
      return pending(`bridge response not JSON: ${(err as Error).message}`);
    }
    if (parsed.error) {
      return pending(`bridge tools/list error: ${parsed.error.message}`);
    }
    const tools = parsed.result?.tools ?? [];
    const names = new Set(tools.map((t) => t.name).filter((n): n is string => typeof n === "string"));
    if (!names.has("propose_memory")) {
      return pending(`bridge tools/list missing propose_memory (got ${[...names].join(", ") || "none"})`);
    }
    return READY;
  } catch (err) {
    return pending(`bridge probe failed: ${(err as Error).message}`);
  } finally {
    cleanup();
  }
}

export const FEATURE_PROBES: Record<FeatureFlag, FeatureProbe> = {
  sessions: (ctx) => (ctx.sessions ? READY : pending("sessions subsystem not wired")),

  dags: (ctx) => (ctx.dags ? READY : pending("dags subsystem not wired")),

  ship: (ctx) => (ctx.ship ? READY : pending("ship subsystem not wired")),

  loops: (ctx) => (ctx.loops ? READY : pending("loops subsystem not wired")),

  variants: (ctx) => (ctx.variants ? READY : pending("variants subsystem not wired")),

  judge: (ctx) => {
    if (!ctx.variants) return pending("variants subsystem not wired");
    return typeof ctx.variants.judge === "function"
      ? READY
      : pending("variants.judge not implemented");
  },

  checkpoints: (ctx) => {
    if (!ctx.sessions) return pending("sessions subsystem not wired");
    return typeof ctx.sessions.checkpoints === "function"
      ? READY
      : pending("sessions.checkpoints not implemented");
  },

  memory: (ctx) => {
    if (!ctx.memory) return pending("memory subsystem not wired");
    try {
      ctx.memory.list();
      return READY;
    } catch (err) {
      return pending(`memory store unreachable: ${(err as Error).message}`);
    }
  },

  "memory-mcp": () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const enginePkgRoot = path.resolve(here, "..", "..");
    const distBridge = path.join(enginePkgRoot, "dist", "memory", "mcpBridge.mjs");
    const srcBridge = path.join(enginePkgRoot, "src", "memory", "mcpBridge.mjs");
    if (existsSync(distBridge) || existsSync(srcBridge)) return READY;
    return pending("memory MCP bridge script not found");
  },

  audit: (ctx) => (ctx.audit ? READY : pending("audit subsystem not wired")),

  resources: (ctx) => (ctx.resource ? READY : pending("resource subsystem not wired")),

  push: (ctx) => (ctx.push ? READY : pending("push subsystem not wired")),

  "external-tasks": (ctx) => (ctx.intake ? READY : pending("intake subsystem not wired")),

  "runtime-overrides": (ctx) => (ctx.runtime ? READY : pending("runtime subsystem not wired")),

  github: (ctx) => {
    if (!ctx.github) return pending("github subsystem not wired");
    return ctx.github.enabled() ? READY : pending("GITHUB_TOKEN not configured");
  },

  "quality-gates": (ctx) => (ctx.quality ? READY : pending("quality subsystem not wired")),

  readiness: (ctx) => (ctx.readiness ? READY : pending("readiness subsystem not wired")),

  "ci-babysit": (ctx) => {
    if (!ctx.ci) return pending("ci subsystem not wired");
    if (!ctx.github) return pending("github subsystem not wired");
    if (!ctx.github.enabled()) return pending("ci-babysit requires GITHUB_TOKEN");
    return READY;
  },

  screenshots: (ctx) => {
    const workspace = ctx.env?.workspace;
    if (!workspace) return pending("workspace dir not configured");
    const probeDir = path.join(workspace, "screenshots", ".probe");
    try {
      mkdirSync(probeDir, { recursive: true });
      rmdirSync(probeDir);
      return READY;
    } catch (err) {
      return pending(`screenshots dir not writable: ${(err as Error).message}`);
    }
  },

  diff: () => READY,

  "pr-preview": () => READY,

  stack: (ctx) => {
    const landing = ctx.landing as { stack?: unknown } | undefined;
    if (!landing || typeof landing.stack !== "function") {
      return pending("landing.stack not yet implemented (pending ship advance)");
    }
    return READY;
  },

  split: () => pending("not implemented"),

  "voice-input": () => pending("not implemented"),
};

export interface FeatureSets {
  ready: FeatureFlag[];
  pending: { flag: FeatureFlag; reason: string }[];
}

export async function computeFeatureSets(ctx: EngineContext): Promise<FeatureSets> {
  const ready: FeatureFlag[] = [];
  const pendingFlags: { flag: FeatureFlag; reason: string }[] = [];
  const entries = Object.entries(FEATURE_PROBES) as [FeatureFlag, FeatureProbe][];
  for (const [flag, probe] of entries) {
    const result = await probe(ctx);
    if (result.ready) {
      ready.push(flag);
    } else {
      pendingFlags.push({ flag, reason: result.reason });
    }
  }
  return { ready, pending: pendingFlags };
}

type CheckOutcome = Omit<DoctorCheck, "name" | "checkedAt">;

export type DoctorCheckProbe = (ctx: EngineContext, env: NodeJS.ProcessEnv) => CheckOutcome | Promise<CheckOutcome>;

export const DOCTOR_CHECKS: Record<DoctorCheckName, DoctorCheckProbe> = {
  "provider-auth": (ctx, env) => {
    const provider = ctx.env?.provider ?? "mock";
    if (provider === "mock") {
      return { status: "ok", detail: "mock provider — no API key required" };
    }
    if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.length > 0) {
      return { status: "ok", detail: `ANTHROPIC_API_KEY present (provider=${provider})` };
    }
    return {
      status: "degraded",
      detail: `provider=${provider} but ANTHROPIC_API_KEY is not set`,
    };
  },

  "github-auth": async (ctx, env) => {
    if (!ctx.github || typeof ctx.github.enabled !== "function" || !ctx.github.enabled()) {
      const hasToken = Boolean(env.GITHUB_TOKEN || env.GH_TOKEN);
      if (hasToken) {
        return {
          status: "degraded",
          detail: "GITHUB_TOKEN/GH_TOKEN present in env but github subsystem reports disabled",
        };
      }
      return {
        status: "degraded",
        detail: "no GitHub credentials — set MINIONS_GH_APP_* or GITHUB_TOKEN",
      };
    }

    try {
      const token = await ctx.github.getToken();
      const res = await fetch("https://api.github.com/installation/repositories?per_page=1", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (res.ok) {
        const via = ctx.env?.githubApp ? "GitHub App" : "GITHUB_TOKEN";
        return { status: "ok", detail: `authenticated via ${via}` };
      }
      return {
        status: "degraded",
        detail: `GitHub API returned ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`,
      };
    } catch (err) {
      return {
        status: "degraded",
        detail: `GitHub auth check failed: ${(err as Error).message}`,
      };
    }
  },

  "repo-state": (ctx) => {
    const repos = typeof ctx.repos === "function" ? ctx.repos() : [];
    if (repos.length === 0) {
      return { status: "degraded", detail: "no repos bound — clone a repo into the workspace" };
    }
    const withRemote = repos.filter((r) => r.remote && r.remote.length > 0).length;
    if (withRemote === 0) {
      return {
        status: "degraded",
        detail: `${repos.length} repo${repos.length === 1 ? "" : "s"} bound but none have a remote`,
      };
    }
    return {
      status: "ok",
      detail: `${repos.length} repo${repos.length === 1 ? "" : "s"} bound (${withRemote} with remote)`,
    };
  },

  "worktree-health": (ctx) => {
    const workspace = ctx.env?.workspace;
    if (!workspace) {
      return { status: "error", detail: "workspace dir not configured" };
    }
    const probeDir = path.join(workspace, ".doctor-probe");
    try {
      mkdirSync(probeDir, { recursive: true });
      rmdirSync(probeDir);
      return { status: "ok", detail: `${workspace} writable` };
    } catch (err) {
      return { status: "error", detail: `workspace not writable: ${(err as Error).message}` };
    }
  },

  "dependency-cache": (ctx) => {
    const workspace = ctx.env?.workspace;
    if (!workspace) {
      return { status: "degraded", detail: "workspace dir not configured" };
    }
    const reposDir = path.join(workspace, ".repos");
    if (!existsSync(reposDir)) {
      return { status: "degraded", detail: "no .repos cache directory yet" };
    }
    let cached = 0;
    try {
      for (const entry of readdirSync(reposDir)) {
        if (!entry.startsWith("v3-") || !entry.endsWith("-deps")) continue;
        const nm = path.join(reposDir, entry, "node_modules");
        if (existsSync(nm)) cached += 1;
      }
    } catch (err) {
      return { status: "error", detail: `cache scan failed: ${(err as Error).message}` };
    }
    if (cached === 0) {
      return {
        status: "degraded",
        detail: "no cached node_modules — first session will install deps",
      };
    }
    return { status: "ok", detail: `${cached} dependency cache${cached === 1 ? "" : "s"} ready` };
  },

  "mcp-availability": () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const enginePkgRoot = path.resolve(here, "..", "..");
    const distBridge = path.join(enginePkgRoot, "dist", "memory", "mcpBridge.mjs");
    const srcBridge = path.join(enginePkgRoot, "src", "memory", "mcpBridge.mjs");
    const found = existsSync(distBridge)
      ? distBridge
      : existsSync(srcBridge)
        ? srcBridge
        : null;
    if (!found) {
      return { status: "error", detail: "memory MCP bridge script not found" };
    }
    return { status: "ok", detail: `bridge: ${path.relative(enginePkgRoot, found)}` };
  },

  "push-config": (ctx) => {
    const app = ctx.env?.githubApp;
    if (!app) {
      return {
        status: "degraded",
        detail: "GitHub App env vars missing (MINIONS_GH_APP_ID / _PRIVATE_KEY / _INSTALLATION_ID)",
      };
    }
    const missing: string[] = [];
    if (!app.id) missing.push("id");
    if (!app.privateKey) missing.push("privateKey");
    if (!app.installationId) missing.push("installationId");
    if (missing.length > 0) {
      return { status: "degraded", detail: `GitHub App config incomplete: ${missing.join(", ")}` };
    }
    return { status: "ok", detail: `GitHub App configured (installation ${app.installationId})` };
  },

  "sidecar-status": (ctx) => {
    const workspace = ctx.env?.workspace;
    if (!workspace) {
      return { status: "degraded", detail: "workspace dir not configured" };
    }
    const pidFile = path.join(workspace, ".sidecar.pid");
    if (!existsSync(pidFile)) {
      return { status: "degraded", detail: "sidecar not running (no pidfile) — expected in unattended Docker" };
    }
    let pid: number;
    try {
      const raw = readFileSync(pidFile, "utf8").trim();
      pid = Number.parseInt(raw, 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        return { status: "degraded", detail: `sidecar pidfile invalid: ${raw}` };
      }
    } catch (err) {
      return { status: "degraded", detail: `sidecar pidfile unreadable: ${(err as Error).message}` };
    }
    try {
      process.kill(pid, 0);
    } catch {
      return { status: "degraded", detail: `sidecar pid ${pid} not alive` };
    }
    const heartbeatFile = path.join(workspace, ".sidecar.heartbeat");
    if (!existsSync(heartbeatFile)) {
      return { status: "degraded", detail: "sidecar stale (last heartbeat: none)" };
    }
    let lastHeartbeat: string;
    let heartbeatMs: number;
    try {
      lastHeartbeat = readFileSync(heartbeatFile, "utf8").trim();
      heartbeatMs = Date.parse(lastHeartbeat);
      if (!Number.isFinite(heartbeatMs)) {
        return {
          status: "degraded",
          detail: `sidecar stale (last heartbeat: ${lastHeartbeat})`,
        };
      }
    } catch (err) {
      return { status: "degraded", detail: `sidecar heartbeat unreadable: ${(err as Error).message}` };
    }
    const ageMs = Date.now() - heartbeatMs;
    if (ageMs > 90_000) {
      return { status: "degraded", detail: `sidecar stale (last heartbeat: ${lastHeartbeat})` };
    }
    const ageSec = Math.max(0, Math.round(ageMs / 1000));
    return { status: "ok", detail: `sidecar pid=${pid}, last heartbeat ${ageSec}s ago` };
  },

  "git-push-auth": async (ctx, env) => {
    const repos = typeof ctx.repos === "function" ? ctx.repos() : [];
    if (repos.length === 0) {
      return { status: "degraded", detail: "no repos bound; skipping git-push-auth probe" };
    }
    const httpsRepo = repos.find((r) => r.remote?.startsWith("https://"));
    if (!httpsRepo) {
      return { status: "ok" };
    }
    if (!ctx.github || typeof ctx.github.enabled !== "function" || !ctx.github.enabled()) {
      const hasToken = Boolean(env.GITHUB_TOKEN || env.GH_TOKEN);
      if (!hasToken) {
        return { status: "degraded", detail: "no GitHub credentials — set MINIONS_GH_APP_* or GITHUB_TOKEN" };
      }
    }
    try {
      await execFileAsync("git", ["ls-remote", "--exit-code", httpsRepo.remote!, "HEAD"], {
        env: gitAuthEnv(env),
        timeout: 10_000,
      });
      return { status: "ok" };
    } catch (err) {
      const msg = (err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? (err as Error).message;
      return { status: "degraded", detail: msg.slice(0, 200) };
    }
  },

  "rest-pr-create-permission": async (ctx, env) => {
    const repos = typeof ctx.repos === "function" ? ctx.repos() : [];
    const httpsRepo = repos.find((r) => r.remote?.startsWith("https://"));
    if (!httpsRepo) {
      return { status: "degraded", detail: "no HTTPS remote bound; skipping rest-pr-create-permission probe" };
    }
    const parsed = parseGithubRemote(httpsRepo.remote!);
    if (!parsed) {
      return { status: "degraded", detail: `cannot parse GitHub remote: ${httpsRepo.remote}` };
    }
    if (!ctx.github || typeof ctx.github.enabled !== "function" || !ctx.github.enabled()) {
      const hasToken = Boolean(env.GITHUB_TOKEN || env.GH_TOKEN);
      if (!hasToken) {
        return { status: "degraded", detail: "no GitHub credentials — set MINIONS_GH_APP_* or GITHUB_TOKEN" };
      }
    }
    const { owner, repo } = parsed;
    try {
      const jwt = typeof ctx.github.getAppJwt === "function" ? ctx.github.getAppJwt() : null;
      if (!jwt) {
        return {
          status: "degraded",
          detail: "rest-pr-create-permission requires GitHub App auth (MINIONS_GH_APP_*); skipping",
        };
      }
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!res.ok) {
        return { status: "degraded", detail: `GitHub API returned ${res.status} for ${owner}/${repo}` };
      }
      const data = (await res.json()) as { permissions?: { pull_requests?: string } };
      const perm = data.permissions?.pull_requests;
      if (perm === "write") {
        return { status: "ok", detail: `App has pull_requests:write on ${owner}/${repo}` };
      }
      return {
        status: "degraded",
        detail: `pull_requests permission is "${perm ?? "missing"}" on ${owner}/${repo}`,
      };
    } catch (err) {
      return { status: "degraded", detail: `rest-pr-create-permission probe failed: ${(err as Error).message}` };
    }
  },

  "rest-checks-read": async (ctx, env) => {
    const repos = typeof ctx.repos === "function" ? ctx.repos() : [];
    const httpsRepo = repos.find((r) => r.remote?.startsWith("https://"));
    if (!httpsRepo) {
      return { status: "degraded", detail: "no HTTPS remote bound; skipping rest-checks-read probe" };
    }
    const parsed = parseGithubRemote(httpsRepo.remote!);
    if (!parsed) {
      return { status: "degraded", detail: `cannot parse GitHub remote: ${httpsRepo.remote}` };
    }
    if (!ctx.github || typeof ctx.github.enabled !== "function" || !ctx.github.enabled()) {
      const hasToken = Boolean(env.GITHUB_TOKEN || env.GH_TOKEN);
      if (!hasToken) {
        return { status: "degraded", detail: "no GitHub credentials — set MINIONS_GH_APP_* or GITHUB_TOKEN" };
      }
    }
    const { owner, repo } = parsed;
    try {
      const token = await ctx.github.getToken();
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits/HEAD/check-runs?per_page=1`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (res.status === 404) {
        return { status: "degraded", detail: "no commits visible" };
      }
      if (!res.ok) {
        return { status: "degraded", detail: `GitHub API returned ${res.status} for ${owner}/${repo}` };
      }
      return { status: "ok", detail: `check-runs readable on ${owner}/${repo}` };
    } catch (err) {
      return { status: "degraded", detail: `rest-checks-read probe failed: ${(err as Error).message}` };
    }
  },
};

export const DOCTOR_CHECK_NAMES: DoctorCheckName[] = [
  "provider-auth",
  "github-auth",
  "repo-state",
  "worktree-health",
  "dependency-cache",
  "mcp-availability",
  "push-config",
  "sidecar-status",
  "git-push-auth",
  "rest-pr-create-permission",
  "rest-checks-read",
];

export async function runDoctorChecks(
  ctx: EngineContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  for (const name of DOCTOR_CHECK_NAMES) {
    const probe = DOCTOR_CHECKS[name];
    const checkedAt = new Date().toISOString();
    try {
      const result = await probe(ctx, env);
      out.push({ name, checkedAt, ...result });
    } catch (err) {
      out.push({
        name,
        status: "error",
        detail: `probe threw: ${(err as Error).message}`,
        checkedAt,
      });
    }
  }
  return out;
}

export type ProviderHealthStatus = "ok" | "degraded";

export interface ProviderHealthEntry {
  status: ProviderHealthStatus;
  reason?: string;
}

type ProviderHealthProbe = () => Promise<ProviderHealthEntry>;

export const PROVIDER_PROBES: Record<string, ProviderHealthProbe> = {
  "claude-code": async () => {
    const bin = await findClaudeBinary();
    if (bin) return { status: "ok" };
    return {
      status: "degraded",
      reason: "claude CLI not found in $PATH",
    };
  },
  mock: async () => ({ status: "ok" }),
};

let providerHealthCache: Record<string, ProviderHealthEntry> | null = null;
let providerHealthInflight: Promise<Record<string, ProviderHealthEntry>> | null = null;

async function probeAllProviders(): Promise<Record<string, ProviderHealthEntry>> {
  const out: Record<string, ProviderHealthEntry> = {};
  for (const [name, probe] of Object.entries(PROVIDER_PROBES)) {
    try {
      out[name] = await probe();
    } catch (err) {
      out[name] = {
        status: "degraded",
        reason: `probe threw: ${(err as Error).message}`,
      };
    }
  }
  return out;
}

export async function computeProviderHealth(): Promise<Record<string, ProviderHealthEntry>> {
  if (providerHealthCache) return providerHealthCache;
  if (providerHealthInflight) return providerHealthInflight;
  providerHealthInflight = probeAllProviders().then((result) => {
    providerHealthCache = result;
    providerHealthInflight = null;
    return result;
  });
  return providerHealthInflight;
}

export function refreshProviderHealth(): void {
  providerHealthCache = null;
  providerHealthInflight = null;
}
