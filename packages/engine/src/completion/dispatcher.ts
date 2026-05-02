import type { Session, SessionUpdatedEvent } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { EventBus } from "../bus/eventBus.js";
import type { Logger } from "../logger.js";
import { newEventId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { sleep } from "../util/time.js";
import {
  parseVerifierVerdict,
  readVerifyChildAttempts,
  VERIFY_CHILD_MAX_RETRIES,
} from "../automation/handlers/verifyChild.js";

type CompletionHandler = (session: Session) => Promise<void>;

export type CompletionHandlerErrorCallback = (
  handler: CompletionHandler,
  session: Session,
  err: Error,
) => void;

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
    private readonly onHandlerError?: CompletionHandlerErrorCallback,
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
        const error = err as Error;
        this.log.error("completion handler error", {
          slug: session.slug,
          handler: handler.name,
          err: error.message,
        });
        if (this.onHandlerError) {
          try {
            this.onHandlerError(handler, session, error);
          } catch (cbErr) {
            this.log.error("completion handler onError callback failed", {
              slug: session.slug,
              handler: handler.name,
              err: (cbErr as Error).message,
            });
          }
        }
      }
    }
  }
}

export function buildCompletionHandlers(ctx: EngineContext, log: Logger): CompletionHandler[] {
  const quotaRetryDelayMs =
    (ctx.runtime.effective()["quotaRetryDelayMs"] as number | undefined) ?? 60_000;

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

  const modeCompletion: CompletionHandler = async (_session) => {
  };

  const loopCompletion: CompletionHandler = async (_session) => {
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

  const verifyChildVerdict: CompletionHandler = async (session) => {
    if (session.metadata["kind"] !== "verify-child") return;
    if (session.status !== "completed") return;

    const targetSlug =
      typeof session.metadata["forSession"] === "string"
        ? (session.metadata["forSession"] as string)
        : null;
    if (!targetSlug) return;

    const target = ctx.sessions.get(targetSlug);
    if (!target) return;

    const transcript = ctx.sessions.transcript(session.slug);
    const verdict = parseVerifierVerdict(transcript);

    if (verdict.kind === "pass") {
      ctx.sessions.setMetadata(targetSlug, { verifyChildPassed: true });
      ctx.audit.record(
        "system",
        "verify-child.pass",
        { kind: "session", id: targetSlug },
        { verifierSlug: session.slug, prNumber: target.pr?.number ?? null },
      );
      return;
    }

    const feedback =
      verdict.kind === "fail" && verdict.feedback && verdict.feedback.length > 0
        ? verdict.feedback
        : "Verifier could not produce a clear PASS/FAIL verdict; please re-read the original task and confirm the implementation matches every acceptance criterion.";

    const attempts = readVerifyChildAttempts(target.metadata);
    if (attempts >= VERIFY_CHILD_MAX_RETRIES) {
      ctx.sessions.setMetadata(targetSlug, { verifyChildExhausted: true });
      ctx.sessions.appendAttention(targetSlug, {
        kind: "verify_failed",
        message: `Verifier reported gaps after ${attempts} retry attempt(s); see verifier session ${session.slug}`,
        raisedAt: nowIso(),
      });
      ctx.audit.record(
        "system",
        "verify-child.exhausted",
        { kind: "session", id: targetSlug },
        { verifierSlug: session.slug, attempts },
      );
      return;
    }

    ctx.sessions.setMetadata(targetSlug, {
      verifyChildAttempts: attempts + 1,
      verifyChildLastVerifier: session.slug,
    });
    try {
      await ctx.sessions.reply(
        targetSlug,
        `A verifier reviewed your PR and reported gaps against the original task. Please address them and push a commit (do NOT open a new PR — keep using the same branch):\n\n${feedback}`,
      );
      await ctx.sessions.kickReplyQueue(targetSlug);
      ctx.audit.record(
        "system",
        "verify-child.requested-rework",
        { kind: "session", id: targetSlug },
        { verifierSlug: session.slug, attempt: attempts + 1 },
      );
    } catch (err) {
      log.warn("verifyChildVerdict: failed to queue rework reply", {
        targetSlug,
        verifierSlug: session.slug,
        err: (err as Error).message,
      });
    }
  };

  const pendingFeedback: CompletionHandler = async (_session) => {
  };

  return [
    quotaRecovery,
    modeCompletion,
    loopCompletion,
    digest,
    restackResolver,
    ciBabysit,
    verifyChildVerdict,
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
