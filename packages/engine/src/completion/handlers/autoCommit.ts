import type { Session } from "@minions/shared";
import { simpleGit, type StatusResult } from "simple-git";
import type { EngineContext } from "../../context.js";
import { newEventId } from "../../util/ids.js";
import { nowIso } from "../../util/time.js";

const STRIPPED_ENV_KEYS = ["GIT_EDITOR", "EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PAGER", "PAGER"] as const;

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

export function autoCommitHandler(ctx: EngineContext): (session: Session) => Promise<void> {
  return async (session: Session) => {
    if (session.status !== "completed") return;
    if (!session.worktreePath || !session.branch || !session.repoId) return;

    const enabled = ctx.runtime.effective()["autoCommitOnCompletion"];
    if (enabled === false) return;

    const git = simpleGit(session.worktreePath).env(buildAutoCommitEnv(process.env));

    try {
      const status = await git.status();
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
