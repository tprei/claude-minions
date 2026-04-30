import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import type { PermissionTier } from "@minions/shared";
import { resolveWorktreeGitPaths } from "../providers/claudeCode.js";
import { ensureDir } from "../util/fs.js";

const SHARED_AUTH_FILES = ["credentials.json", ".credentials.json"];

const READ_TOOLS_ALLOW = ["Read(*)", "Glob(*)", "Grep(*)"];
const WRITE_TOOLS_ALLOW = [
  "Bash(*)",
  "Read(*)",
  "Write(*)",
  "Edit(*)",
  "Glob(*)",
  "Grep(*)",
  "TodoWrite(*)",
];

export function permissionsAllowFor(tier: PermissionTier): string[] {
  return tier === "read" ? READ_TOOLS_ALLOW : WRITE_TOOLS_ALLOW;
}

async function symlinkOperatorAuth(claudeDir: string): Promise<void> {
  const operatorClaudeDir = path.join(os.homedir(), ".claude");
  for (const filename of SHARED_AUTH_FILES) {
    const src = path.join(operatorClaudeDir, filename);
    try {
      await fs.access(src);
    } catch {
      continue;
    }
    const dst = path.join(claudeDir, filename);
    try {
      await fs.unlink(dst);
    } catch {
      // ok if missing
    }
    await fs.symlink(src, dst);
  }
}

export async function writeSessionSettings(
  homeDir: string,
  worktreePath: string,
  permissionTier: PermissionTier,
): Promise<void> {
  const { gitDir, gitCommonDir } = await resolveWorktreeGitPaths(worktreePath);

  const allowOnly = Array.from(new Set([worktreePath, gitDir, gitCommonDir]));

  const settings = {
    sandbox: {
      write: {
        allowOnly,
      },
    },
    permissions: {
      allow: permissionsAllowFor(permissionTier),
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

  await symlinkOperatorAuth(claudeDir);
}
