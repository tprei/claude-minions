import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { EngineContext } from "../../src/context.js";
import type { EngineEnv } from "../../src/env.js";
import { createEngine } from "../../src/index.js";
import { createLogger } from "../../src/logger.js";

export interface TestEngine {
  ctx: EngineContext;
  baseUrl: string;
  token: string;
  close: () => Promise<void>;
}

export async function createTestEngine(opts?: Partial<EngineEnv>): Promise<TestEngine> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "minions-engine-test-"));
  const token = `test-${randomBytes(8).toString("hex")}`;

  const env: EngineEnv = {
    port: 0,
    host: "127.0.0.1",
    token,
    corsOrigins: ["http://localhost:5173"],
    workspace,
    provider: "mock",
    logLevel: "error",
    vapid: null,
    resourceSampleSec: 60,
    loopTickSec: 60,
    loopReservedInteractive: 4,
    ssePingSec: 60,
    apiVersion: "1",
    libraryVersion: "0.1.0-test",
    ...opts,
  };

  const log = createLogger(env.logLevel, { service: "engine-test" });
  const ctx = await createEngine(env, log);
  const baseUrl = `http://${env.host}:${ctx.env.port}`;

  let closed = false;
  return {
    ctx,
    baseUrl,
    token: env.token,
    close: async () => {
      if (closed) return;
      closed = true;
      await ctx.shutdown();
      fs.rmSync(workspace, { recursive: true, force: true });
    },
  };
}
