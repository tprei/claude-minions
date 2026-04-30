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
        { pushedAndOpened: false, error: `commits-ahead probe failed: ${message}` },
      );
      return;
    }

    if (ahead <= 0) {
      ctx.audit.record(
        "completion",
        "session.auto-land",
        { kind: "session", id: session.slug },
        { pushedAndOpened: false, reason: "no commits ahead of baseBranch" },
      );
      return;
    }

    emitStatus(ctx, session.slug, `auto-land: pushing branch and opening PR (${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${baseBranch})`);

    try {
      await ctx.landing.openForReview(session.slug);
      ctx.audit.record(
        "completion",
        "session.auto-land",
        { kind: "session", id: session.slug },
        { pushedAndOpened: true, baseBranch },
      );

      const fresh = ctx.sessions.get(session.slug);
      const concluded = fresh?.metadata["ciSelfHealConcluded"];
      const maxAttempts = readSelfHealMaxAttempts(ctx);

      if (concluded === "success" || concluded === "exhausted") {
        emitStatus(
          ctx,
          session.slug,
          `auto-land: PR refreshed (CI self-heal previously ${concluded})`,
        );
      } else if (maxAttempts > 0) {
        const alreadySelfHealing = fresh?.metadata["selfHealCi"] === true;
        if (!alreadySelfHealing) {
          ctx.sessions.setMetadata(session.slug, {
            selfHealCi: true,
            ciSelfHealAttempts: 0,
          });
        }
        const hasCiPending = (fresh?.attention ?? []).some((a) => a.kind === "ci_pending");
        if (!hasCiPending) {
          ctx.sessions.appendAttention(session.slug, {
            kind: "ci_pending",
            message: "Waiting for CI to complete on the auto-landed PR",
            raisedAt: new Date().toISOString(),
          });
        }
        ctx.sessions.markWaitingInput(
          session.slug,
          "ci self-heal: parking until CI reports terminal state",
        );

        emitStatus(
          ctx,
          session.slug,
          "auto-land: branch pushed and PR opened — parking session in waiting_input; CI self-heal will replay failures into this session",
        );
      } else {
        emitStatus(
          ctx,
          session.slug,
          "auto-land: branch pushed and PR opened — CI babysitter takes over from here",
        );
      }
    } catch (err) {
      const message = (err as Error).message;
      ctx.audit.record(
        "completion",
        "session.auto-land",
        { kind: "session", id: session.slug },
        { pushedAndOpened: false, error: message },
      );
      emitStatus(ctx, session.slug, `auto-land failed: ${message}`, "warn");
    }
  };
  Object.defineProperty(handler, "name", { value: "autoLandHandler" });
  return handler;
}

export const DEFAULT_CI_SELF_HEAL_MAX_ATTEMPTS = 3;

function readSelfHealMaxAttempts(ctx: EngineContext): number {
  const raw = ctx.runtime.effective()["ciSelfHealMaxAttempts"];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_CI_SELF_HEAL_MAX_ATTEMPTS;
  }
  return Math.floor(raw);
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
