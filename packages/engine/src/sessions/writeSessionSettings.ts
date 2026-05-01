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

// WebFetch and WebSearch are billed per call and routinely cost 5–20× a
// `gh api` round-trip for the same data. The runtime image ships `gh` + git
// + curl + a pre-authenticated GH_TOKEN env, so the agent always has a
// cheaper path to GitHub. Block both tools across all permission tiers.
const TOOLS_DENY = ["WebFetch", "WebSearch"];

export function permissionsAllowFor(tier: PermissionTier): string[] {
  return tier === "read" ? READ_TOOLS_ALLOW : WRITE_TOOLS_ALLOW;
}

export function permissionsDenyFor(_tier: PermissionTier): string[] {
  return TOOLS_DENY;
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
      const existing = await fs.readlink(dst);
      if (existing === src) continue;
      await fs.unlink(dst);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EINVAL") {
        // ENOENT: nothing to remove. EINVAL: not a symlink (regular file/dir we'd rather leave alone).
        // Anything else is unexpected — surface it.
        throw err;
      }
    }
    try {
      await fs.symlink(src, dst);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        // Concurrent spawn beat us to it. Treat as success regardless of target —
        // re-throwing here breaks parallel session spawns. If the target differs,
        // a later spawn will re-evaluate via the readlink path above.
        continue;
      }
      throw err;
    }
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
      deny: permissionsDenyFor(permissionTier),
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
