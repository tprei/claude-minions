import type { Session } from "@minions/shared";
import { simpleGit } from "simple-git";
import type { EngineContext } from "../../context.js";
import { newEventId } from "../../util/ids.js";
import { nowIso } from "../../util/time.js";

const STRIPPED_ENV_KEYS = ["GIT_EDITOR", "EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PAGER"] as const;

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
      const hasChanges =
        status.files.length > 0 ||
        status.not_added.length > 0 ||
        status.modified.length > 0 ||
        status.created.length > 0 ||
        status.deleted.length > 0 ||
        status.renamed.length > 0 ||
        status.staged.length > 0;

      if (!hasChanges) {
        ctx.audit.record(
          "completion",
          "session.auto-commit",
          { kind: "session", id: session.slug },
          { committed: false },
        );
        return;
      }

      await git.add(".");
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
