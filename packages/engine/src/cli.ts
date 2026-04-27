import { loadEnv } from "./env.js";
import { loadDotenvFiles } from "./dotenv.js";
import { createLogger } from "./logger.js";
import { createEngine } from "./index.js";
import type { EngineContext } from "./context.js";

async function main(): Promise<void> {
  loadDotenvFiles(process.cwd());
  const env = loadEnv(process.env);
  const log = createLogger(env.logLevel, { service: "engine" });

  log.info("starting engine", { port: env.port, workspace: env.workspace, provider: env.provider });

  let ctx: EngineContext | undefined;

  try {
    ctx = await createEngine(env, log);
  } catch (err) {
    log.error("engine failed to start", { message: (err as Error).message, stack: (err as Error).stack });
    process.exit(1);
  }

  async function shutdown(signal: string): Promise<void> {
    log.info("received signal, shutting down", { signal });
    try {
      await ctx?.shutdown();
      log.info("shutdown complete");
      process.exit(0);
    } catch (err) {
      log.error("shutdown error", { message: (err as Error).message });
      process.exit(1);
    }
  }

  process.once("SIGINT", () => {
    shutdown("SIGINT").catch(() => process.exit(1));
  });

  process.once("SIGTERM", () => {
    shutdown("SIGTERM").catch(() => process.exit(1));
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
