import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";

export async function onPrUpdated(
  slug: string,
  ctx: EngineContext,
  log: Logger,
): Promise<void> {
  const session = ctx.sessions.get(slug);
  if (!session) return;
  if (!session.pr) return;

  const { pr } = session;

  if (pr.state === "merged" || pr.state === "closed") {
    if (session.status === "running" || session.status === "waiting_input") {
      log.info("PR closed/merged, stopping session", { slug, prState: pr.state });
      await ctx.sessions.stop(slug, `PR ${pr.state}`).catch((err) => {
        log.warn("could not stop session on PR close", { slug, err: (err as Error).message });
      });
    }

    ctx.bus.emit({
      kind: "session_updated",
      session: ctx.sessions.get(slug) ?? session,
    });
  }
}
