import type { ShipStage, TranscriptEvent } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";
import type Database from "better-sqlite3";
import { nowIso } from "../util/time.js";
import { newEventId } from "../util/ids.js";
import {
  THINK_DIRECTIVE,
  PLAN_DIRECTIVE,
  DAG_DIRECTIVE,
  VERIFY_DIRECTIVE,
  DONE_DIRECTIVE,
} from "./stages.js";
import { parseDagFromTranscript } from "../dag/parser.js";
import { EngineError } from "../errors.js";

const THINK_MIN_ASSISTANT_TEXT_LENGTH = 80;

function findStageStartSeq(events: TranscriptEvent[], stage: ShipStage): number {
  let seq = -1;
  for (const e of events) {
    if (e.kind !== "status") continue;
    const data = e.data;
    if (data && data["toStage"] === stage) seq = e.seq;
  }
  return seq;
}

const STAGE_ORDER: ShipStage[] = ["think", "plan", "dag", "verify", "done"];

function stageDirective(stage: ShipStage): string {
  switch (stage) {
    case "think":
      return THINK_DIRECTIVE;
    case "plan":
      return PLAN_DIRECTIVE;
    case "dag":
      return DAG_DIRECTIVE;
    case "verify":
      return VERIFY_DIRECTIVE;
    case "done":
      return DONE_DIRECTIVE;
  }
}

function nextStage(current: ShipStage): ShipStage | null {
  const idx = STAGE_ORDER.indexOf(current);
  if (idx === -1 || idx === STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[idx + 1] ?? null;
}

interface ShipStateRow {
  session_slug: string;
  stage: string;
  notes: string;
  updated_at: string;
}

export class ShipCoordinator {
  private readonly stmtGetState: Database.Statement;
  private readonly stmtUpsertState: Database.Statement;
  private readonly stmtCountTranscript: Database.Statement;
  private readonly stmtMaxSeq: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly ctx: EngineContext,
    private readonly log: Logger,
  ) {
    this.stmtGetState = db.prepare(`SELECT * FROM ship_state WHERE session_slug = ?`);
    this.stmtUpsertState = db.prepare(`
      INSERT INTO ship_state(session_slug, stage, notes, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_slug) DO UPDATE SET stage = excluded.stage, notes = excluded.notes, updated_at = excluded.updated_at
    `);
    this.stmtCountTranscript = db.prepare(
      `SELECT COUNT(*) as cnt FROM transcript_events WHERE session_slug = ?`,
    );
    this.stmtMaxSeq = db.prepare(
      `SELECT COALESCE(MAX(seq), -1) as max_seq FROM transcript_events WHERE session_slug = ?`,
    );
  }

  getStage(slug: string): ShipStage | null {
    const row = this.stmtGetState.get(slug) as ShipStateRow | undefined;
    if (!row) return null;
    return row.stage as ShipStage;
  }

  async advance(slug: string, toStage?: ShipStage, note?: string): Promise<void> {
    await this.ctx.mutex.run(slug, async () => {
      await this.advanceLocked(slug, toStage, note);
    });
  }

  private async advanceLocked(
    slug: string,
    toStage?: ShipStage,
    note?: string,
  ): Promise<void> {
    const session = this.ctx.sessions.get(slug);
    if (!session) throw new EngineError("not_found", `session not found: ${slug}`);
    if (session.mode !== "ship") {
      throw new EngineError("bad_request", `session ${slug} is not a ship session`);
    }

    const currentStage = this.getStage(slug) ?? "think";

    let target: ShipStage;
    if (toStage) {
      target = toStage;
    } else {
      const next = nextStage(currentStage);
      if (!next) {
        this.log.info("ship session already at done stage", { slug });
        return;
      }
      target = next;
    }

    const notes: string[] = JSON.parse(
      (this.stmtGetState.get(slug) as ShipStateRow | undefined)?.notes ?? "[]",
    ) as string[];
    if (note) notes.push(note);

    this.stmtUpsertState.run(slug, target, JSON.stringify(notes), nowIso());

    this.db.prepare(
      `UPDATE sessions SET ship_stage = ?, updated_at = ? WHERE slug = ?`,
    ).run(target, nowIso(), slug);

    this.emitStatusEvent(slug, target, currentStage);

    const updatedSession = this.ctx.sessions.get(slug);
    if (updatedSession) {
      this.ctx.bus.emit({ kind: "session_updated", session: updatedSession });
    }

    const directive = stageDirective(target);
    await this.ctx.sessions.reply(
      slug,
      `[Ship stage: ${target}]\n\n${directive}`,
    );

    this.log.info("ship stage advanced", { slug, from: currentStage, to: target });

    if (target === "verify") {
      try {
        await this.emitVerifySummary(slug);
      } catch (e) {
        this.log.error("emitVerifySummary failed during advance", {
          slug,
          message: (e as Error).message,
        });
      }
    }
  }

  async emitVerifySummary(slug: string): Promise<void> {
    const dag = this.ctx.dags.list().find((d) => d.rootSessionSlug === slug) ?? null;
    let text: string;
    const data: Record<string, unknown> = { kind: "verify_summary" };

    if (!dag) {
      text = "Verify summary: no DAG bound to this ship session.";
    } else {
      data["dagId"] = dag.id;
      const landed = dag.nodes.filter((n) => n.status === "landed");
      const lines: string[] = [
        `Verify summary for DAG "${dag.title}" (${landed.length}/${dag.nodes.length} nodes landed):`,
      ];
      if (landed.length === 0) {
        lines.push("- no landed nodes yet");
      } else {
        const prs: { number: number; url: string; node: string }[] = [];
        const readinessRows: { slug: string; status: string }[] = [];
        for (const node of landed) {
          const prText = node.pr ? `PR #${node.pr.number} ${node.pr.url}` : "no PR";
          if (node.pr) prs.push({ number: node.pr.number, url: node.pr.url, node: node.id });
          let readinessText = "readiness unknown";
          let ciText = "ci unknown";
          if (node.sessionSlug) {
            const r = await this.computeReadinessSafe(node.sessionSlug);
            if (r) {
              readinessText = `readiness ${r.status}`;
              readinessRows.push({ slug: node.sessionSlug, status: r.status });
              const ciCheck = r.checks.find((c) => c.id === "ci");
              if (ciCheck) {
                ciText = `ci ${ciCheck.status}${ciCheck.detail ? ` (${ciCheck.detail})` : ""}`;
              }
            }
          }
          lines.push(`- ${node.title}: ${prText} — ${readinessText}, ${ciText}`);
        }
        data["prs"] = prs;
        data["readiness"] = readinessRows;
      }
      text = lines.join("\n");
    }

    this.insertStatusEvent(slug, text, data);
  }

  private async computeReadinessSafe(
    sessionSlug: string,
  ): Promise<import("@minions/shared").MergeReadiness | null> {
    try {
      return await this.ctx.readiness.compute(sessionSlug);
    } catch (e) {
      this.log.warn("verify summary: readiness compute failed", {
        slug: sessionSlug,
        message: (e as Error).message,
      });
      return null;
    }
  }

  async onTurnCompleted(slug: string): Promise<void> {
    await this.ctx.mutex.run(slug, async () => {
      const session = this.ctx.sessions.get(slug);
      if (!session) return;
      if (session.mode !== "ship") return;

      const stage = this.getStage(slug);
      if (!stage) return;
      if (stage === "done") return;

      const shouldAdvance = await this.checkExitCondition(slug, stage);
      if (!shouldAdvance) {
        this.log.debug("ship stage exit condition not met", { slug, stage });
        return;
      }

      await this.advanceLocked(slug);
    });
  }

  async reconcileOnBoot(): Promise<void> {
    let rows: ShipStateRow[];
    try {
      rows = this.db
        .prepare(
          `SELECT s.*
           FROM ship_state s
           INNER JOIN sessions sess ON sess.slug = s.session_slug
           WHERE sess.mode = 'ship'
             AND s.stage != 'done'
             AND sess.status NOT IN ('completed', 'failed', 'cancelled')`,
        )
        .all() as ShipStateRow[];
    } catch (e) {
      this.log.error("ship reconcileOnBoot query failed", { message: (e as Error).message });
      return;
    }

    for (const row of rows) {
      try {
        await this.onTurnCompleted(row.session_slug);
      } catch (e) {
        this.log.error("ship reconcileOnBoot advance failed", {
          slug: row.session_slug,
          stage: row.stage,
          message: (e as Error).message,
        });
      }
    }

    if (rows.length > 0) {
      this.log.info("ship reconcileOnBoot evaluated sessions", { count: rows.length });
    }
  }

  private async checkExitCondition(slug: string, stage: ShipStage): Promise<boolean> {
    switch (stage) {
      case "think":
        return this.hasSubstantialAssistantText(slug);
      case "plan":
        return this.hasParseableDagBlock(slug);
      case "dag":
        return this.allDagNodesLanded(slug);
      case "verify":
        return await this.readinessReady(slug);
      case "done":
        return false;
    }
  }

  private hasSubstantialAssistantText(slug: string): boolean {
    const events = this.ctx.sessions.transcript(slug);
    const stage = this.getStage(slug) ?? "think";
    const stageStartSeq = findStageStartSeq(events, stage);
    let totalLength = 0;
    for (const e of events) {
      if (e.seq <= stageStartSeq) continue;
      if (e.kind !== "assistant_text") continue;
      totalLength += e.text.length;
      if (totalLength > THINK_MIN_ASSISTANT_TEXT_LENGTH) return true;
    }
    return false;
  }

  private hasParseableDagBlock(slug: string): boolean {
    const events = this.ctx.sessions.transcript(slug);
    return parseDagFromTranscript(events) !== null;
  }

  private allDagNodesLanded(slug: string): boolean {
    const dag = this.ctx.dags.list().find((d) => d.rootSessionSlug === slug);
    if (!dag) return false;
    if (dag.nodes.length === 0) return false;
    return dag.nodes.every((n) => n.status === "landed");
  }

  private async readinessReady(slug: string): Promise<boolean> {
    let readiness: import("@minions/shared").MergeReadiness | null;
    try {
      readiness = await this.ctx.readiness.compute(slug);
    } catch (err) {
      this.log.debug("readiness compute failed during ship advance", {
        slug,
        err: (err as Error).message,
      });
      return false;
    }
    if (!readiness) return false;
    return readiness.status === "ready";
  }

  private emitStatusEvent(slug: string, toStage: ShipStage, fromStage: ShipStage): void {
    this.insertStatusEvent(
      slug,
      `Ship stage transition: ${fromStage} → ${toStage}`,
      { fromStage, toStage },
    );
  }

  private insertStatusEvent(
    slug: string,
    text: string,
    data: Record<string, unknown>,
  ): void {
    const seqRow = this.stmtMaxSeq.get(slug) as { max_seq: number } | undefined;
    const seq = (seqRow?.max_seq ?? -1) + 1;

    const countRow = this.stmtCountTranscript.get(slug) as { cnt: number } | undefined;
    const turn = countRow?.cnt ?? 0;

    const statusEvent = {
      id: newEventId(),
      sessionSlug: slug,
      seq,
      turn,
      timestamp: nowIso(),
      kind: "status" as const,
      level: "info" as const,
      text,
      data,
    };

    this.db.prepare(
      `INSERT INTO transcript_events(id, session_slug, seq, turn, kind, body, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      statusEvent.id,
      slug,
      seq,
      turn,
      statusEvent.kind,
      JSON.stringify(statusEvent),
      statusEvent.timestamp,
    );

    this.ctx.bus.emit({ kind: "transcript_event", sessionSlug: slug, event: statusEvent });
  }
}
