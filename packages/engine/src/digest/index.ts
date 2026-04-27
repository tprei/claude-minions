import type { TranscriptEvent } from "@minions/shared";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { EngineError } from "../errors.js";
import { newEventId } from "../util/ids.js";
import { nowIso } from "../util/time.js";

interface TranscriptRow {
  id: string;
  session_slug: string;
  seq: number;
  turn: number;
  kind: string;
  body: string;
  timestamp: string;
}

function buildSummary(events: TranscriptEvent[]): string {
  const lines: string[] = [];

  for (const event of events) {
    if (event.kind === "assistant_text") {
      const firstLine = event.text.split("\n")[0]?.trim() ?? "";
      if (firstLine) {
        lines.push(`- ${firstLine}`);
      }
    } else if (event.kind === "tool_call") {
      lines.push(`- [${event.toolName}] ${event.summary}`);
    }
  }

  if (lines.length === 0) {
    return "_No significant activity in last 30 events._";
  }

  return lines.join("\n");
}

export interface DigestSubsystem {
  summarize: (slug: string) => Promise<string>;
}

export function createDigestSubsystem(deps: SubsystemDeps): SubsystemResult<DigestSubsystem> {
  const api: DigestSubsystem = {
    async summarize(slug) {
      const rows = deps.db
        .prepare(
          `SELECT * FROM transcript_events WHERE session_slug = ?
           ORDER BY seq DESC LIMIT 30`
        )
        .all(slug) as TranscriptRow[];

      if (rows.length === 0) {
        throw new EngineError("not_found", `No transcript events for session ${slug}`);
      }

      const events = rows
        .reverse()
        .map((row) => JSON.parse(row.body) as TranscriptEvent);

      const summaryText = buildSummary(events);

      const maxSeq = rows.reduce((max, r) => Math.max(max, r.seq), 0);
      const maxTurn = rows.reduce((max, r) => Math.max(max, r.turn), 0);

      const statusEvent: TranscriptEvent = {
        id: newEventId(),
        sessionSlug: slug,
        seq: maxSeq + 1,
        turn: maxTurn,
        kind: "status",
        level: "info",
        text: summaryText,
        data: { digest: true },
        timestamp: nowIso(),
      };

      deps.db
        .prepare(
          `INSERT INTO transcript_events(id, session_slug, seq, turn, kind, body, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          statusEvent.id,
          slug,
          statusEvent.seq,
          statusEvent.turn,
          statusEvent.kind,
          JSON.stringify(statusEvent),
          statusEvent.timestamp
        );

      deps.bus.emit({ kind: "transcript_event", sessionSlug: slug, event: statusEvent });
      deps.log.info("digest summarized", { slug, lines: summaryText.split("\n").length });

      return summaryText;
    },
  };

  return { api };
}
