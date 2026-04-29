import type { Session } from "@minions/shared";
import { simpleGit } from "simple-git";
import type { EngineContext } from "../../context.js";
import { newEventId } from "../../util/ids.js";
import { nowIso } from "../../util/time.js";

export async function commitsAhead(
  worktreePath: string,
  branch: string,
  baseBranch: string,
): Promise<number> {
  const git = simpleGit(worktreePath);
  const range = `${baseBranch}..${branch}`;
  const out = await git.raw(["rev-list", "--count", range]);
  const n = Number.parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

export function autoLandHandler(ctx: EngineContext): (session: Session) => Promise<void> {
  const handler = async (session: Session): Promise<void> => {
    if (session.status !== "completed") return;
    if (session.mode !== "task") return;
    if (!session.worktreePath || !session.branch || !session.repoId) return;

    const enabled = ctx.runtime.effective()["autoLandOnCompletion"];
    if (enabled === false) return;

    const baseBranch = session.baseBranch ?? "main";

    let ahead = 0;
    try {
      ahead = await commitsAhead(session.worktreePath, session.branch, baseBranch);
    } catch (err) {
      const message = (err as Error).message;
      ctx.audit.record(
        "completion",
        "session.auto-land",
        { kind: "session", id: session.slug },
        { landed: false, error: `commits-ahead probe failed: ${message}` },
      );
      return;
    }

    if (ahead <= 0) {
      ctx.audit.record(
        "completion",
        "session.auto-land",
        { kind: "session", id: session.slug },
        { landed: false, reason: "no commits ahead of baseBranch" },
      );
      return;
    }

    emitStatus(ctx, session.slug, `auto-land: pushing branch and opening PR (${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${baseBranch})`);

    try {
      await ctx.landing.land(session.slug, "squash", false);
      ctx.audit.record(
        "completion",
        "session.auto-land",
        { kind: "session", id: session.slug },
        { landed: true, strategy: "squash", baseBranch },
      );
      emitStatus(ctx, session.slug, "auto-land: PR opened and merge attempted");
    } catch (err) {
      const message = (err as Error).message;
      ctx.audit.record(
        "completion",
        "session.auto-land",
        { kind: "session", id: session.slug },
        { landed: false, error: message },
      );
      emitStatus(ctx, session.slug, `auto-land failed: ${message}`, "warn");
    }
  };
  Object.defineProperty(handler, "name", { value: "autoLandHandler" });
  return handler;
}

function emitStatus(
  ctx: EngineContext,
  sessionSlug: string,
  text: string,
  level: "info" | "warn" = "info",
): void {
  ctx.bus.emit({
    kind: "transcript_event",
    sessionSlug,
    event: {
      id: newEventId(),
      sessionSlug,
      seq: Date.now(),
      turn: 0,
      timestamp: nowIso(),
      kind: "status",
      level,
      text,
    },
  });
}
