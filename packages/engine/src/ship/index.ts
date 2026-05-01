import type { ShipStage } from "@minions/shared";
import type Database from "better-sqlite3";
import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { ShipCoordinator } from "./coordinator.js";
import type { AutomationJobRepo } from "../store/repos/automationJobRepo.js";

interface ShipStateRow {
  session_slug: string;
  stage: string;
  notes: string;
  updated_at: string;
}

function reconcileOnBoot(db: Database.Database, ctx: EngineContext, log: Logger): void {
  const rows = db.prepare(`SELECT * FROM ship_state`).all() as ShipStateRow[];

  for (const row of rows) {
    const slug = row.session_slug;
    const stage = row.stage as ShipStage;

    try {
      const session = ctx.sessions.get(slug);
      if (!session) {
        log.warn("ship boot reconcile: session row missing for ship_state", { slug, stage });
        ctx.audit.record(
          "system",
          "ship.boot-reconcile",
          { kind: "session", id: slug },
          { stage, status: "session-missing" },
        );
        continue;
      }

      if (
        session.status === "completed" ||
        session.status === "failed" ||
        session.status === "cancelled"
      ) {
        if (stage !== "done") {
          log.warn("ship session terminated mid-stage", {
            slug,
            stage,
            status: session.status,
          });
        }
        ctx.audit.record(
          "system",
          "ship.boot-reconcile",
          { kind: "session", id: slug },
          { stage, status: session.status, midStage: stage !== "done" },
        );
        continue;
      }

      log.info("ship session re-armed", { slug, stage });
      ctx.audit.record(
        "system",
        "ship.boot-reconcile",
        { kind: "session", id: slug },
        { stage, status: session.status, action: "re-armed" },
      );
    } catch (err) {
      log.error("ship boot reconcile failed for row", {
        slug,
        err: (err as Error).message,
      });
      ctx.audit.record(
        "system",
        "ship.boot-reconcile.failed",
        { kind: "session", id: slug },
        { error: (err as Error).message },
      );
    }
  }
}

export function createShipSubsystem(
  deps: SubsystemDeps & { automationRepo?: AutomationJobRepo },
): SubsystemResult<EngineContext["ship"]> {
  const { ctx, db, log, automationRepo } = deps;

  const coordinator = new ShipCoordinator(
    db,
    ctx,
    log.child({ subsystem: "ship-coordinator" }),
    automationRepo ?? null,
  );

  reconcileOnBoot(db, ctx, log.child({ subsystem: "ship-coordinator" }));

  const api: EngineContext["ship"] = {
    async advance(slug: string, toStage?: ShipStage, note?: string): Promise<void> {
      await coordinator.advance(slug, toStage, note);
    },

    async onTurnCompleted(slug: string): Promise<void> {
      await coordinator.onTurnCompleted(slug);
    },

    async reconcileOnBoot(): Promise<void> {
      await coordinator.reconcileOnBoot();
    },
  };

  queueMicrotask(() => {
    void reconcileVerifySummariesOnBoot(db, coordinator, log.child({ subsystem: "ship-coordinator" }));
  });

  return {
    api,
    onShutdown() {
      coordinator.shutdown();
    },
  };
}

interface VerifyStageRow {
  session_slug: string;
}

async function reconcileVerifySummariesOnBoot(
  db: Database.Database,
  coordinator: ShipCoordinator,
  log: Logger,
): Promise<void> {
  let rows: VerifyStageRow[];
  try {
    rows = db
      .prepare(
        `SELECT s.session_slug
         FROM ship_state s
         INNER JOIN sessions sess ON sess.slug = s.session_slug
         WHERE s.stage = 'verify'
           AND sess.status NOT IN ('completed', 'failed', 'cancelled')`,
      )
      .all() as VerifyStageRow[];
  } catch (e) {
    log.error("ship boot reconcile query failed", { message: (e as Error).message });
    return;
  }

  for (const row of rows) {
    try {
      await coordinator.emitVerifySummary(row.session_slug);
    } catch (e) {
      log.error("ship boot reconcile emit failed", {
        slug: row.session_slug,
        message: (e as Error).message,
      });
    }
  }

  if (rows.length > 0) {
    log.info("ship boot reconcile re-emitted verify summaries", { count: rows.length });
  }
}

export { ShipCoordinator } from "./coordinator.js";
