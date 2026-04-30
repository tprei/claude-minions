import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { resolveWorktreeGitPaths } from "../providers/claudeCode.js";
import { ensureDir } from "../util/fs.js";

const SHARED_AUTH_FILES = ["credentials.json", ".credentials.json"];

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

function resolvePolicyScript(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const enginePkgRoot = path.resolve(here, "..", "..");
  const distScript = path.join(enginePkgRoot, "dist", "sessions", "policy", name);
  const srcScript = path.join(enginePkgRoot, "src", "sessions", "policy", name);
  if (existsSync(distScript)) return distScript;
  return srcScript;
}

export interface WriteSessionSettingsOpts {
  slug: string;
  policyHooksEnabled: boolean;
}

export async function writeSessionSettings(
  homeDir: string,
  worktreePath: string,
  opts: WriteSessionSettingsOpts,
): Promise<void> {
  const { gitDir, gitCommonDir } = await resolveWorktreeGitPaths(worktreePath);

  const allowOnly = Array.from(new Set([worktreePath, gitDir, gitCommonDir]));

  const base = {
    sandbox: {
      write: {
        allowOnly,
      },
    },
    includeCoAuthoredBy: false,
    disableWelcomeMessage: true,
    disableNonEssentialModelCalls: true,
    bashTimeout: 120000,
    bashMaxOutputLength: 100000,
    apiKeyHelper: "",
  };

  let hooks: Record<string, unknown> | undefined;
  if (opts.policyHooksEnabled === true) {
    const preToolUse = resolvePolicyScript("preToolUseBash.mjs");
    const stopHint = resolvePolicyScript("stopHint.mjs");
    hooks = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: `node ${preToolUse}`,
              timeout: 5,
              env: { MINIONS_WORKTREE: worktreePath, MINIONS_SLUG: opts.slug },
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [{ type: "command", command: `node ${stopHint}`, timeout: 5 }],
        },
      ],
    };
  }

  const settings = { ...base, ...(hooks ? { hooks } : {}) };

  const claudeDir = path.join(homeDir, ".claude");
  await ensureDir(claudeDir);
  await fs.writeFile(
    path.join(claudeDir, "settings.json"),
    JSON.stringify(settings, null, 2),
    "utf8",
  );

  await symlinkOperatorAuth(claudeDir);
}
