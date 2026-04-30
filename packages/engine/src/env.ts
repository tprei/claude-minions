import path from "node:path";
import os from "node:os";
import { EngineError } from "./errors.js";

export interface EngineEnv {
  port: number;
  host: string;
  token: string;
  corsOrigins: string[];
  workspace: string;
  provider: string;
  logLevel: "debug" | "info" | "warn" | "error";
  vapid: { publicKey: string; privateKey: string; subject: string } | null;
  githubApp: { id: string; privateKey: string; installationId: string } | null;
  resourceSampleSec: number;
  loopTickSec: number;
  loopReservedInteractive: number;
  ssePingSec: number;
  apiVersion: string;
  libraryVersion: string;
  webDist: string | null;
  crashLogDir: string;
}

const DEFAULT_CORS_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

function parseCorsOrigins(v: string | undefined): string[] {
  if (v === undefined || v.trim() === "") return [...DEFAULT_CORS_ORIGINS];
  if (v.trim() === "none") return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function asInt(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function level(v: string | undefined): "debug" | "info" | "warn" | "error" {
  switch (v) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return v;
    default:
      return "info";
  }
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): EngineEnv {
  const workspace = env.MINIONS_WORKSPACE
    ? path.resolve(env.MINIONS_WORKSPACE)
    : path.resolve(process.cwd(), "workspace");

  const vapidPub = env.MINIONS_VAPID_PUBLIC ?? "";
  const vapidPriv = env.MINIONS_VAPID_PRIVATE ?? "";
  const vapidSubject = env.MINIONS_VAPID_SUBJECT ?? `mailto:ops@${os.hostname()}`;

  const ghAppId = env.MINIONS_GH_APP_ID ?? "";
  const ghAppPrivateKey = env.MINIONS_GH_APP_PRIVATE_KEY ?? "";
  const ghAppInstallationId = env.MINIONS_GH_APP_INSTALLATION_ID ?? "";
  const githubApp =
    ghAppId && ghAppPrivateKey && ghAppInstallationId
      ? { id: ghAppId, privateKey: ghAppPrivateKey, installationId: ghAppInstallationId }
      : null;

  const rawToken = env.MINIONS_TOKEN ?? "";
  const allowInsecureToken = env.MINIONS_ALLOW_INSECURE_TOKEN === "1";
  if (!allowInsecureToken && (rawToken === "" || rawToken === "changeme")) {
    throw new EngineError(
      "internal",
      "Refusing to start: MINIONS_TOKEN must be set to a unique secret (not empty, not 'changeme'). " +
        "Set MINIONS_ALLOW_INSECURE_TOKEN=1 to bypass this check (not recommended outside local development).",
    );
  }

  return {
    port: asInt(env.MINIONS_PORT, 8787),
    host: env.MINIONS_HOST ?? "127.0.0.1",
    token: rawToken,
    corsOrigins: parseCorsOrigins(env.MINIONS_CORS_ORIGINS),
    workspace,
    provider: env.MINIONS_PROVIDER ?? "mock",
    logLevel: level(env.MINIONS_LOG_LEVEL),
    vapid: vapidPub && vapidPriv ? { publicKey: vapidPub, privateKey: vapidPriv, subject: vapidSubject } : null,
    githubApp,
    resourceSampleSec: asInt(env.MINIONS_RESOURCE_SAMPLE_SEC, 2),
    loopTickSec: asInt(env.MINIONS_LOOP_TICK_SEC, 5),
    loopReservedInteractive: asInt(env.MINIONS_LOOP_RESERVED_INTERACTIVE, 4),
    ssePingSec: asInt(env.MINIONS_SSE_PING_SEC, 25),
    apiVersion: "1",
    libraryVersion: "0.1.0",
    webDist:
      env.MINIONS_SERVE_WEB === "true" && env.MINIONS_WEB_DIST
        ? path.resolve(env.MINIONS_WEB_DIST)
        : null,
    crashLogDir: env.MINIONS_CRASH_LOG_DIR
      ? path.resolve(env.MINIONS_CRASH_LOG_DIR)
      : path.join(os.homedir(), ".minions", "crashes"),
  };
}
