import type Database from "better-sqlite3";
import type { EventBus } from "../bus/eventBus.js";
import type { ProviderEvent } from "../providers/provider.js";
import type { Logger } from "../logger.js";
import type { EngineContext } from "../context.js";
import { newEventId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { eventToRow, rowToTranscriptEvent, rowToSession, type SessionRow } from "./mapper.js";
import { maybeApplyBudgetCap } from "./budgetCap.js";

export interface TranscriptCollectorDeps {
  db: Database.Database;
  bus: EventBus;
  log: Logger;
  ctx?: EngineContext;
}

export class TranscriptCollector {
  private readonly insertStmt: Database.Statement;
  private readonly getLastSeqStmt: Database.Statement;
  private readonly updateStatsStmt: Database.Statement;
  private readonly updateStatusStmt: Database.Statement;
  private readonly getSessionStmt: Database.Statement;
  private readonly getSessionForBusStmt: Database.Statement;
  private readonly updateProviderStateStmt: Database.Statement;

  constructor(private readonly deps: TranscriptCollectorDeps) {
    const { db } = deps;

    this.insertStmt = db.prepare(
      `INSERT OR IGNORE INTO transcript_events(id, session_slug, seq, turn, kind, body, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    this.getLastSeqStmt = db.prepare(
      `SELECT COALESCE(MAX(seq), -1) AS last_seq FROM transcript_events WHERE session_slug = ?`,
    );

    this.updateStatsStmt = db.prepare(
      `UPDATE sessions SET
         stats_turns = stats_turns + ?,
         stats_tool_calls = stats_tool_calls + ?,
         stats_input_tokens = stats_input_tokens + ?,
         stats_output_tokens = stats_output_tokens + ?,
         stats_cache_read_tokens = stats_cache_read_tokens + ?,
         stats_cache_creation_tokens = stats_cache_creation_tokens + ?,
         stats_cost_usd = stats_cost_usd + ?,
         updated_at = ?,
         last_turn_at = CASE WHEN ? > 0 THEN ? ELSE last_turn_at END
       WHERE slug = ?`,
    );

    this.updateStatusStmt = db.prepare(
      `UPDATE sessions SET status = ?, updated_at = ?, started_at = COALESCE(started_at, ?), completed_at = ?
       WHERE slug = ?`,
    );

    this.getSessionStmt = db.prepare(
      `SELECT slug, status FROM sessions WHERE slug = ?`,
    );

    this.getSessionForBusStmt = db.prepare(
      `SELECT * FROM sessions WHERE slug = ?`,
    );

    this.updateProviderStateStmt = db.prepare(
      `UPDATE provider_state SET last_seq = ?, last_turn = ?, updated_at = ? WHERE session_slug = ?`,
    );
  }

  private nextSeq(slug: string): number {
    const row = this.getLastSeqStmt.get(slug) as { last_seq: number };
    return (row.last_seq ?? -1) + 1;
  }

  private emitSessionUpdated(slug: string): void {
    const row = this.getSessionForBusStmt.get(slug) as SessionRow | undefined;
    if (!row) return;
    const childSlugs = (this.deps.db
      .prepare(`SELECT slug FROM sessions WHERE parent_slug = ?`)
      .all(slug) as Array<{ slug: string }>)
      .map((r) => r.slug);
    const session = rowToSession(row, childSlugs);
    this.deps.bus.emit({ kind: "session_updated", session });
  }

  private applyStatsDelta(
    slug: string,
    timestamp: string,
    turnDelta: number,
    toolCallDelta: number,
    inputTokensDelta: number,
    outputTokensDelta: number,
    cacheReadDelta: number,
    cacheCreationDelta: number,
    costDelta: number,
  ): void {
    this.updateStatsStmt.run(
      turnDelta,
      toolCallDelta,
      inputTokensDelta,
      outputTokensDelta,
      cacheReadDelta,
      cacheCreationDelta,
      costDelta,
      timestamp,
      turnDelta,
      timestamp,
      slug,
    );
  }

  async collect(
    slug: string,
    events: AsyncIterable<ProviderEvent>,
    onExternalId?: (id: string) => void,
    startTurn = 0,
  ): Promise<void> {
    const { bus, log, ctx } = this.deps;
    let turn = startTurn;
    let turnDelta = 0;
    let toolCallDelta = 0;
    let hasFirstEvent = false;

    for await (const ev of events) {
      if (ev.kind === "session_id") {
        onExternalId?.(ev.externalId);
        continue;
      }

      if (!hasFirstEvent) {
        hasFirstEvent = true;
        const sessionRow = this.getSessionStmt.get(slug) as { slug: string; status: string } | undefined;
        if (sessionRow && sessionRow.status === "pending") {
          this.updateStatusStmt.run("running", nowIso(), nowIso(), null, slug);
          this.emitSessionUpdated(slug);
        }
      }

      if (ev.kind === "turn_started") {
        turn++;
        turnDelta++;
      } else if (ev.kind === "tool_call") {
        toolCallDelta++;
      }

      const seq = this.nextSeq(slug);
      const id = newEventId();
      const timestamp = nowIso();
      const row = eventToRow(slug, id, seq, turn, timestamp, ev);

      if (!row) continue;

      this.deps.db.transaction(() => {
        this.insertStmt.run(row.id, row.session_slug, row.seq, row.turn, row.kind, row.body, row.timestamp);
        this.updateProviderStateStmt.run(row.seq, row.turn, row.timestamp, slug);
      })();

      const transcriptEv = rowToTranscriptEvent(row);
      bus.emit({ kind: "transcript_event", sessionSlug: slug, event: transcriptEv });

      if (ev.kind === "turn_completed") {
        const usage = ev.usage ?? {};
        const inputTokensDelta = usage.inputTokens ?? 0;
        const outputTokensDelta = usage.outputTokens ?? 0;
        const cacheReadDelta = usage.cacheReadTokens ?? 0;
        const cacheCreationDelta = usage.cacheCreationTokens ?? 0;
        const costDelta = ev.costUsd ?? 0;

        const hasStatsDelta =
          turnDelta > 0 ||
          toolCallDelta > 0 ||
          inputTokensDelta > 0 ||
          outputTokensDelta > 0 ||
          cacheReadDelta > 0 ||
          cacheCreationDelta > 0 ||
          costDelta > 0;

        if (hasStatsDelta) {
          this.applyStatsDelta(
            slug,
            timestamp,
            turnDelta,
            toolCallDelta,
            inputTokensDelta,
            outputTokensDelta,
            cacheReadDelta,
            cacheCreationDelta,
            costDelta,
          );
          turnDelta = 0;
          toolCallDelta = 0;
        }

        if (ctx && costDelta > 0) {
          const newCostRow = this.getSessionForBusStmt.get(slug) as SessionRow | undefined;
          if (newCostRow) {
            maybeApplyBudgetCap(ctx, slug, newCostRow.stats_cost_usd);
          }
        }

        if (ev.outcome === "needs_input") {
          this.updateStatusStmt.run("waiting_input", timestamp, timestamp, null, slug);
          this.emitSessionUpdated(slug);
        }
      }
    }

    if (turnDelta > 0 || toolCallDelta > 0) {
      this.applyStatsDelta(slug, nowIso(), turnDelta, toolCallDelta, 0, 0, 0, 0, 0);
    }

    log.debug("transcript collector done", { slug });
  }
}
