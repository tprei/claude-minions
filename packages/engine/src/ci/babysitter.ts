import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";

const POLL_INTERVAL_MS = 30_000;

export class CiBabysitter {
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ctx: EngineContext,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.handle = setInterval(() => {
      this.pollAll().catch((err) => {
        this.log.error("ci babysitter poll error", { err: (err as Error).message });
      });
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  private async pollAll(): Promise<void> {
    const sessions = this.ctx.sessions.list().filter(
      (s) =>
        s.pr &&
        s.pr.state === "open" &&
        s.status !== "failed" &&
        s.status !== "completed" &&
        s.status !== "cancelled",
    );

    for (const session of sessions) {
      await this.ctx.ci.poll(session.slug).catch((err) => {
        this.log.warn("ci poll failed", { slug: session.slug, err: (err as Error).message });
      });
    }
  }
}
