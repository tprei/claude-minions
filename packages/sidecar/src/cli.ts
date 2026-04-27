import { SidecarClient } from "./client.js";
import { createLogger, parseLevel } from "./log.js";
import { RulesEngine } from "./rulesEngine.js";
import { allRules, selectRules } from "./rules/index.js";

function parseRules(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return ["all"];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main(): Promise<void> {
  const baseUrl = process.env["MINIONS_ENGINE_URL"] ?? "http://127.0.0.1:8787";
  const token = process.env["MINIONS_TOKEN"];
  if (!token) {
    process.stderr.write("MINIONS_TOKEN is required\n");
    process.exit(1);
  }
  const level = parseLevel(process.env["SIDECAR_LOG_LEVEL"]);
  const requested = parseRules(process.env["SIDECAR_RULES"]);

  const log = createLogger(level, { service: "sidecar" });

  const rules = selectRules(requested);
  if (rules.length === 0) {
    log.error("no rules selected — check SIDECAR_RULES", {
      requested,
      available: allRules.map((r) => r.id),
    });
    process.exit(1);
  }

  log.info("starting sidecar", {
    baseUrl,
    rules: rules.map((r) => r.id),
  });

  const client = new SidecarClient({ baseUrl, token, log: log.child({ component: "client" }) });
  const engine = new RulesEngine({
    client,
    rules,
    log: log.child({ component: "rules-engine" }),
  });

  engine.start();

  const shutdown = async (signal: string): Promise<void> => {
    log.info("shutting down", { signal });
    try {
      await engine.stop();
    } catch (err) {
      log.error("shutdown error", { err: String(err) });
    }
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
