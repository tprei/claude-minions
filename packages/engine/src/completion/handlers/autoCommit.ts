import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { Session } from "@minions/shared";
import { simpleGit, type StatusResult } from "simple-git";
import type { EngineContext } from "../../context.js";
import { newEventId } from "../../util/ids.js";
import { nowIso } from "../../util/time.js";

const execFileAsync = promisify(execFile);

const STRIPPED_ENV_KEYS = ["GIT_EDITOR", "EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PAGER", "PAGER"] as const;

const PACKAGE_JSON_PATTERN = /^(?:packages\/[^/]+\/|apps\/[^/]+\/)?package\.json$/;
const PNPM_INSTALL_TIMEOUT_MS = 5 * 60_000;
const PNPM_INSTALL_MAX_BUFFER = 10 * 1024 * 1024;

export const INJECTED_ASSET_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  "instructions.md",
  ".cursor/",
  ".minions/",
] as const;

function isInjectedAssetPath(p: string): boolean {
  for (const injected of INJECTED_ASSET_PATHS) {
    if (injected.endsWith("/")) {
      const dir = injected.slice(0, -1);
      if (p === dir || p.startsWith(injected)) return true;
    } else if (p === injected) {
      return true;
    }
  }
  return false;
}

export function commitablePathsFromStatus(status: StatusResult): string[] {
  const candidates = [...status.not_added, ...status.modified, ...status.created];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of candidates) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (isInjectedAssetPath(p)) continue;
    out.push(p);
  }
  return out;
}

export function buildAutoCommitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const stripped = new Set<string>(STRIPPED_ENV_KEYS);
  for (const [key, value] of Object.entries(base)) {
    if (stripped.has(key)) continue;
    env[key] = value;
  }
  env.GIT_AUTHOR_NAME = "minions-engine";
  env.GIT_AUTHOR_EMAIL = "engine@minions.local";
  env.GIT_COMMITTER_NAME = "minions-engine";
  env.GIT_COMMITTER_EMAIL = "engine@minions.local";
  return env;
}

export function statusIncludesPackageJsonChange(status: StatusResult): boolean {
  const all = [...status.modified, ...status.created, ...status.not_added];
  return all.some((p) => PACKAGE_JSON_PATTERN.test(p));
}

export interface PnpmInstallResult {
  stdout: string;
  stderr: string;
}

export type PnpmInstallRunner = (
  worktreePath: string,
  env: NodeJS.ProcessEnv,
) => Promise<PnpmInstallResult>;

const defaultPnpmInstallRunner: PnpmInstallRunner = async (worktreePath, env) => {
  const { stdout, stderr } = await execFileAsync(
    "pnpm",
    ["install", "--no-frozen-lockfile", "--prefer-offline"],
    {
      cwd: worktreePath,
      env,
      timeout: PNPM_INSTALL_TIMEOUT_MS,
      maxBuffer: PNPM_INSTALL_MAX_BUFFER,
    },
  );
  return { stdout, stderr };
};

async function hasPnpmLockfile(worktreePath: string): Promise<boolean> {
  try {
    await fs.access(path.join(worktreePath, "pnpm-lock.yaml"));
    return true;
  } catch {
    return false;
  }
}

export interface AutoCommitDeps {
  runPnpmInstall?: PnpmInstallRunner;
}

export function autoCommitHandler(
  ctx: EngineContext,
  deps: AutoCommitDeps = {},
): (session: Session) => Promise<void> {
  const runPnpmInstall = deps.runPnpmInstall ?? defaultPnpmInstallRunner;

  return async (session: Session) => {
    if (session.status !== "completed") return;
    if (!session.worktreePath || !session.branch || !session.repoId) return;

    const enabled = ctx.runtime.effective()["autoCommitOnCompletion"];
    if (enabled === false) return;

    const env = buildAutoCommitEnv(process.env);
    const git = simpleGit(session.worktreePath).env(env);

    try {
      let status = await git.status();

      if (statusIncludesPackageJsonChange(status) && (await hasPnpmLockfile(session.worktreePath))) {
        try {
          const { stdout, stderr } = await runPnpmInstall(session.worktreePath, env);
          ctx.audit.record(
            "completion",
            "session.auto-commit.lockfile-refresh",
            { kind: "session", id: session.slug },
            { ok: true, stdout, stderr },
          );
          status = await git.status();
        } catch (err) {
          const e = err as Error & { stdout?: string; stderr?: string };
          const message = e.message;
          ctx.audit.record(
            "completion",
            "session.auto-commit",
            { kind: "session", id: session.slug },
            {
              committed: false,
              attention: "lockfile_refresh_failed",
              error: message,
              stdout: e.stdout ?? "",
              stderr: e.stderr ?? "",
            },
          );
          ctx.bus.emit({
            kind: "transcript_event",
            sessionSlug: session.slug,
            event: {
              id: newEventId(),
              sessionSlug: session.slug,
              seq: Date.now(),
              turn: 0,
              timestamp: nowIso(),
              kind: "status",
              level: "warn",
              text: `auto-commit aborted: lockfile refresh failed (${message})`,
            },
          });
          return;
        }
      }

      const toAdd = commitablePathsFromStatus(status);

      if (toAdd.length === 0) {
        ctx.audit.record(
          "completion",
          "session.auto-commit",
          { kind: "session", id: session.slug },
          { committed: false },
        );
        return;
      }

      await git.add(toAdd);
      await git.commit(`session:${session.slug} ${session.title}`);
      const sha = (await git.revparse(["HEAD"])).trim();

      ctx.audit.record(
        "completion",
        "session.auto-commit",
        { kind: "session", id: session.slug },
        { committed: true, sha },
      );
    } catch (err) {
      const message = (err as Error).message;
      ctx.bus.emit({
        kind: "transcript_event",
        sessionSlug: session.slug,
        event: {
          id: newEventId(),
          sessionSlug: session.slug,
          seq: Date.now(),
          turn: 0,
          timestamp: nowIso(),
          kind: "status",
          level: "warn",
          text: `auto-commit failed: ${message}`,
        },
      });
      ctx.audit.record(
        "completion",
        "session.auto-commit",
        { kind: "session", id: session.slug },
        { committed: false, error: message },
      );
    }
  };
}
