import type { Session, SessionUpdatedEvent } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { EventBus } from "../bus/eventBus.js";
import type { Logger } from "../logger.js";
import { newEventId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { sleep } from "../util/time.js";

type CompletionHandler = (session: Session) => Promise<void>;

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function isTerminal(status: Session["status"]): boolean {
  return TERMINAL_STATUSES.has(status);
}

export class CompletionDispatcher {
  private readonly handlers: CompletionHandler[] = [];
  private readonly previousStatuses = new Map<string, Session["status"]>();

  constructor(
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {}

  register(handler: CompletionHandler): void {
    this.handlers.push(handler);
  }

  wire(): () => void {
    return this.bus.on("session_updated", (event: SessionUpdatedEvent) => {
      const session = event.session;
      const prev = this.previousStatuses.get(session.slug);
      this.previousStatuses.set(session.slug, session.status);

      if (!isTerminal(session.status)) return;
      if (prev && isTerminal(prev)) return;

      this.dispatch(session).catch((err: unknown) => {
        this.log.error("completion dispatch error", {
          slug: session.slug,
          err: (err as Error).message,
        });
      });
    });
  }

  private async dispatch(session: Session): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(session);
      } catch (err) {
        this.log.error("completion handler error", {
          slug: session.slug,
          handler: handler.name,
          err: (err as Error).message,
        });
      }
    }
  }
}

export function buildCompletionHandlers(ctx: EngineContext, log: Logger): CompletionHandler[] {
  const quotaRetryDelayMs =
    (ctx.runtime.effective()["quotaRetryDelayMs"] as number | undefined) ?? 60_000;

  const qualityGate: CompletionHandler = async (session) => {
    if (session.status !== "completed") return;
    try {
      await ctx.quality.runForSession(session.slug);
    } catch (err) {
      log.warn("quality gate error in completion", {
        slug: session.slug,
        err: (err as Error).message,
      });
    }
  };

  const quotaRecovery: CompletionHandler = async (session) => {
    const quotaFlag = session.attention.find((f) => f.kind === "quota_exhausted");
    if (!quotaFlag) return;
    const delay =
      (ctx.runtime.effective()["quotaRetryDelayMs"] as number | undefined) ?? quotaRetryDelayMs;
    log.info("scheduling quota retry", { slug: session.slug, delayMs: delay });
    setTimeout(() => {
      ctx.sessions
        .reply(session.slug, "Quota has recovered. Please continue.")
        .catch((err: unknown) => {
          log.error("quota recovery reply failed", {
            slug: session.slug,
            err: (err as Error).message,
          });
        });
    }, delay);
  };

  const shipStageAdvance: CompletionHandler = async (session) => {
    if (session.mode !== "ship") return;
    if (session.status !== "completed") return;
    await ctx.ship.onTurnCompleted(session.slug);
  };

  const modeCompletion: CompletionHandler = async (_session) => {
  };

  const loopCompletion: CompletionHandler = async (_session) => {
  };

  const taskCompletion: CompletionHandler = async (session) => {
    if (session.mode !== "dag-task") return;
    await ctx.dags.onSessionTerminal(session.slug);
  };

  const digest: CompletionHandler = async (session) => {
    if (session.status !== "completed") return;
    try {
      const summary = await ctx.digest.summarize(session.slug);
      emitStatusEvent(ctx, session.slug, summary);
    } catch (err) {
      log.warn("digest summarize error", {
        slug: session.slug,
        err: (err as Error).message,
      });
    }
  };

  const restackResolver: CompletionHandler = async (session) => {
    if (session.mode !== "rebase-resolver") return;
    if (session.status !== "completed") return;
    const parentSlug = session.parentSlug;
    if (!parentSlug) return;
    try {
      await ctx.landing.retryRebase(parentSlug);
      log.info("restack continuation after resolver completed", { slug: session.slug, parentSlug });
    } catch (err) {
      log.warn("restack continuation failed after resolver", {
        slug: session.slug,
        parentSlug,
        err: (err as Error).message,
      });
    }
  };

  const ciBabysit: CompletionHandler = async (session) => {
    if (session.status !== "completed") return;
    try {
      await ctx.ci.poll(session.slug);
    } catch (err) {
      log.warn("ci babysit error", {
        slug: session.slug,
        err: (err as Error).message,
      });
    }
  };

  const parentNotify: CompletionHandler = async (session) => {
    const parentSlug = session.parentSlug;
    if (!parentSlug) return;
    const parent = ctx.sessions.get(parentSlug);
    if (!parent) return;

    emitStatusEvent(
      ctx,
      parentSlug,
      `Child session ${session.slug} (${session.mode}) terminated with status: ${session.status}`,
    );
  };

  const pendingFeedback: CompletionHandler = async (_session) => {
  };

  void sleep;

  return [
    qualityGate,
    quotaRecovery,
    shipStageAdvance,
    modeCompletion,
    loopCompletion,
    taskCompletion,
    digest,
    restackResolver,
    ciBabysit,
    parentNotify,
    pendingFeedback,
  ];
}

function emitStatusEvent(ctx: EngineContext, sessionSlug: string, text: string): void {
  const event = {
    id: newEventId(),
    sessionSlug,
    seq: Date.now(),
    turn: 0,
    timestamp: nowIso(),
    kind: "status" as const,
    level: "info" as const,
    text,
  };
  ctx.bus.emit({ kind: "transcript_event", sessionSlug, event });
}
