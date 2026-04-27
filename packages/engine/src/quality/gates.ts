import { readFile } from "node:fs/promises";
import path from "node:path";
import type { QualityGateConfig } from "@minions/shared";
import type { Logger } from "../logger.js";

export async function loadGateConfig(
  worktreePath: string,
  log: Logger,
): Promise<QualityGateConfig[]> {
  const configPath = path.join(worktreePath, ".minions", "quality.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      log.warn("quality.json is not an array", { configPath });
      return [];
    }
    return parsed as QualityGateConfig[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    log.warn("failed to read quality.json", { configPath, err: (err as Error).message });
    return [];
  }
}
