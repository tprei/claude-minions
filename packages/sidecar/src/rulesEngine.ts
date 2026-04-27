import type { AuditEvent, ServerEvent } from "@minions/shared";
import type { SidecarClient, SseSubscription } from "./client.js";
import type { Logger } from "./log.js";
import type { Rule } from "./rules/index.js";

const TICK_INTERVAL_MS = 30_000;
const AUDIT_POLL_INTERVAL_MS = 30_000;
const AUDIT_BATCH_LIMIT = 200;

export interface RulesEngineOptions {
  client: SidecarClient;
  rules: Rule[];
  log: Logger;
}

export class RulesEngine {
  private readonly client: SidecarClient;
  private readonly rules: Rule[];
  private readonly log: Logger;

  private sub: SseSubscription | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private auditTimer: NodeJS.Timeout | null = null;
  private lastAuditId: string | null = null;
  private stopped = false;

  constructor(opts: RulesEngineOptions) {
    this.client = opts.client;
    this.rules = opts.rules;
    this.log = opts.log;
  }

  start(): void {
    this.log.info("starting rules engine", {
      rules: this.rules.map((r) => r.id),
    });

    for (const rule of this.rules) {
      try {
        rule.init?.(this.client);
      } catch (err) {
        this.log.error("rule init threw", { rule: rule.id, err: String(err) });
      }
    }

    this.sub = this.client.subscribeEvents({
      onOpen: () => this.log.info("sse connected"),
      onError: (err) => this.log.warn("sse error", { err: String(err) }),
      onAny: async (event) => this.dispatch(event),
    });

    void this.runTick();
    this.tickTimer = setInterval(() => void this.runTick(), TICK_INTERVAL_MS);

    void this.pollAudit(true);
    this.auditTimer = setInterval(() => void this.pollAudit(false), AUDIT_POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.auditTimer) clearInterval(this.auditTimer);
    this.sub?.close();
  }

  private async dispatch(event: ServerEvent): Promise<void> {
    if (event.kind === "session_updated" || event.kind === "session_created") {
      const session = event.session;
      await Promise.allSettled(
        this.rules.map(async (r) => {
          if (!r.onSessionUpdated) return;
          try {
            await r.onSessionUpdated(session, this.client);
          } catch (err) {
            this.log.error("rule.onSessionUpdated threw", {
              rule: r.id,
              slug: session.slug,
              err: String(err),
            });
          }
        }),
      );
    } else if (event.kind === "transcript_event") {
      const { sessionSlug, event: ev } = event;
      await Promise.allSettled(
        this.rules.map(async (r) => {
          if (!r.onTranscriptEvent) return;
          try {
            await r.onTranscriptEvent(sessionSlug, ev, this.client);
          } catch (err) {
            this.log.error("rule.onTranscriptEvent threw", {
              rule: r.id,
              slug: sessionSlug,
              err: String(err),
            });
          }
        }),
      );
    }
  }

  private async runTick(): Promise<void> {
    if (this.stopped) return;
    await Promise.allSettled(
      this.rules.map(async (r) => {
        if (!r.tick) return;
        try {
          await r.tick(this.client);
        } catch (err) {
          this.log.error("rule.tick threw", { rule: r.id, err: String(err) });
        }
      }),
    );
  }

  private async pollAudit(initial: boolean): Promise<void> {
    if (this.stopped) return;
    let events: AuditEvent[];
    try {
      events = await this.client.getAuditEvents(AUDIT_BATCH_LIMIT);
    } catch (err) {
      this.log.warn("audit poll failed", { err: String(err) });
      return;
    }

    const ordered = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (initial) {
      const last = ordered[ordered.length - 1];
      if (last) this.lastAuditId = last.id;
      return;
    }

    let cutoffIdx = -1;
    if (this.lastAuditId !== null) {
      cutoffIdx = ordered.findIndex((e) => e.id === this.lastAuditId);
    }
    const fresh = cutoffIdx >= 0 ? ordered.slice(cutoffIdx + 1) : ordered;
    if (fresh.length === 0) return;

    const last = fresh[fresh.length - 1];
    if (last) this.lastAuditId = last.id;

    for (const ev of fresh) {
      await Promise.allSettled(
        this.rules.map(async (r) => {
          if (!r.onAuditEvent) return;
          try {
            await r.onAuditEvent(ev, this.client);
          } catch (err) {
            this.log.error("rule.onAuditEvent threw", {
              rule: r.id,
              auditId: ev.id,
              err: String(err),
            });
          }
        }),
      );
    }
  }
}
