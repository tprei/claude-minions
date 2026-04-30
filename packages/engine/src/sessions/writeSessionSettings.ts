import path from "node:path";
import fs from "node:fs/promises";
import { resolveWorktreeGitPaths } from "../providers/claudeCode.js";
import { ensureDir } from "../util/fs.js";

export async function writeSessionSettings(
  homeDir: string,
  worktreePath: string,
): Promise<void> {
  const { gitDir, gitCommonDir } = await resolveWorktreeGitPaths(worktreePath);

  const allowOnly = Array.from(new Set([worktreePath, gitDir, gitCommonDir]));

  const settings = {
    sandbox: {
      write: {
        allowOnly,
      },
    },
    includeCoAuthoredBy: false,
    disableWelcomeMessage: true,
    disableAllHooks: true,
    disableNonEssentialModelCalls: true,
    bashTimeout: 120000,
    bashMaxOutputLength: 100000,
    apiKeyHelper: "",
  };

  const claudeDir = path.join(homeDir, ".claude");
  await ensureDir(claudeDir);
  await fs.writeFile(
    path.join(claudeDir, "settings.json"),
    JSON.stringify(settings, null, 2),
    "utf8",
  );
}
