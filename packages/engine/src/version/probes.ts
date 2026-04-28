import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorCheck, DoctorCheckName, FeatureFlag } from "@minions/shared";
import type { EngineContext } from "../context.js";

export type ProbeResult = { ready: true } | { ready: false; reason: string };
export type FeatureProbe = (ctx: EngineContext) => ProbeResult | Promise<ProbeResult>;

const READY: ProbeResult = { ready: true };
const pending = (reason: string): ProbeResult => ({ ready: false, reason });

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

  "github-auth": (ctx, env) => {
    if (ctx.github && typeof ctx.github.enabled === "function" && ctx.github.enabled()) {
      const via = ctx.env?.githubApp ? "GitHub App" : "GITHUB_TOKEN";
      return { status: "ok", detail: `authenticated via ${via}` };
    }
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
      return {
        status: "degraded",
        detail: "sidecar not detected — start with pnpm --filter @minions/sidecar dev",
      };
    }
    try {
      const raw = readFileSync(pidFile, "utf8").trim();
      const pid = Number.parseInt(raw, 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        return { status: "degraded", detail: `sidecar pidfile invalid: ${raw}` };
      }
      try {
        process.kill(pid, 0);
      } catch {
        return { status: "degraded", detail: `sidecar pid ${pid} not alive` };
      }
      const stat = statSync(pidFile);
      const ageMs = Date.now() - stat.mtimeMs;
      const ageMin = Math.round(ageMs / 60000);
      return { status: "ok", detail: `sidecar pid ${pid} (pidfile ${ageMin}m old)` };
    } catch (err) {
      return { status: "degraded", detail: `sidecar pidfile unreadable: ${(err as Error).message}` };
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
