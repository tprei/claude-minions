import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";

const POLL_INTERVAL_MS = 30_000;
const MAX_POLLS_PER_TICK = 5;

export class CiBabysitter {
  private handle: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;

  constructor(
    private readonly ctx: EngineContext,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.handle) return;
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

    if (sessions.length === 0) {
      this.cursor = 0;
      return;
    }

    const take = Math.min(MAX_POLLS_PER_TICK, sessions.length);
    const batch = [];
    for (let i = 0; i < take; i++) {
      batch.push(sessions[(this.cursor + i) % sessions.length]!);
    }
    this.cursor = (this.cursor + take) % sessions.length;

    for (const session of batch) {
      await this.ctx.ci.poll(session.slug).catch((err) => {
        this.log.warn("ci poll failed", { slug: session.slug, err: (err as Error).message });
      });
    }
  }
}
