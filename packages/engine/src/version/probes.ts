import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FeatureFlag } from "@minions/shared";
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
