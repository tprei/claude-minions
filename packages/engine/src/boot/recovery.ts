import type Database from "better-sqlite3";
import type { ShipStage } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";
import { nowIso } from "../util/time.js";

export const ENGINE_BOOTED_AT = nowIso();

interface ShipSessionRow {
  slug: string;
  stage: string;
}

const ENGINE_TARGET = { kind: "system", id: "engine" } as const;

export async function runBootRecovery(
  ctx: EngineContext,
  db: Database.Database,
  log: Logger,
): Promise<void> {
  if (ctx.runtime.effective().bootRecovery === false) {
    ctx.audit.record("system", "boot_recovery.skipped", ENGINE_TARGET);
    log.info("boot recovery skipped via runtime config");
    return;
  }

  const rows = db
    .prepare(
      `SELECT s.slug AS slug, ss.stage AS stage
         FROM sessions s
         JOIN ship_state ss ON ss.session_slug = s.slug
        WHERE s.mode = 'ship'
          AND s.status IN ('running', 'pending')
          AND s.ship_stage IS NOT NULL`,
    )
    .all() as ShipSessionRow[];

  for (const row of rows) {
    const slug = row.slug;
    const stage = row.stage as ShipStage;
    try {
      if (stage === "dag") {
        // dag stage handled by sibling task — placeholder branch.
        continue;
      }

      if (stage !== "think" && stage !== "plan" && stage !== "verify") {
        continue;
      }

      const session = ctx.sessions.get(slug);
      if (!session) {
        ctx.audit.record(
          "system",
          "boot_recovery.session_recovered.failed",
          { kind: "session", id: slug },
          { slug, error: "session row missing" },
        );
        continue;
      }

      if (session.status === "running" || session.status === "waiting_input") {
        ctx.audit.record(
          "system",
          "boot_recovery.session_recovered",
          { kind: "session", id: slug },
          { stage, outcome: "resumed" },
        );
        continue;
      }

      const alreadyFlagged = session.attention.some(
        (flag) =>
          flag.kind === "manual_intervention" &&
          typeof flag.message === "string" &&
          flag.message.startsWith("crashed_during_"),
      );

      if (!alreadyFlagged) {
        ctx.sessions.appendAttention(slug, {
          kind: "manual_intervention",
          message: `crashed_during_${stage}`,
          raisedAt: nowIso(),
        });
      }

      ctx.audit.record(
        "system",
        "boot_recovery.session_recovered",
        { kind: "session", id: slug },
        { stage, outcome: "attention_raised" },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("boot recovery row failed", { slug, stage, error: message });
      ctx.audit.record(
        "system",
        "boot_recovery.session_recovered.failed",
        { kind: "session", id: slug },
        { slug, error: message },
      );
    }
  }
}
