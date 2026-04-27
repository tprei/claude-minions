import type { MergeReadiness, ReadinessSummary } from "@minions/shared";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { EngineError } from "../errors.js";
import {
  computePrCheck,
  computeReviewCheck,
  computeQualityCheck,
  computeCiCheck,
  computeConflictCheck,
  computeOverallStatus,
} from "./compute.js";
import { registerReadinessRoutes } from "./routes.js";

export interface ReadinessSubsystem {
  compute: (slug: string) => Promise<MergeReadiness>;
  summary: () => ReadinessSummary;
}

interface ReadinessRow {
  session_slug: string;
  status: string;
  checks: string;
  computed_at: string;
}

function rowToReadiness(row: ReadinessRow): MergeReadiness {
  return {
    sessionSlug: row.session_slug,
    status: row.status as MergeReadiness["status"],
    checks: JSON.parse(row.checks) as MergeReadiness["checks"],
    computedAt: row.computed_at,
  };
}

export function createReadinessSubsystem(deps: SubsystemDeps): SubsystemResult<ReadinessSubsystem> {
  const { db, ctx } = deps;

  const stmtGet = db.prepare<[string], ReadinessRow>(
    "SELECT * FROM merge_readiness WHERE session_slug = ?",
  );
  const stmtUpsert = db.prepare<[string, string, string, string], void>(
    `INSERT INTO merge_readiness (session_slug, status, checks, computed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_slug) DO UPDATE SET status=excluded.status, checks=excluded.checks, computed_at=excluded.computed_at`,
  );

  async function compute(slug: string): Promise<MergeReadiness> {
    const session = ctx.sessions.get(slug);
    if (!session) throw new EngineError("not_found", `Session ${slug} not found`);

    const qualityReport = ctx.quality.getReport(slug);

    const checks = [
      computePrCheck(session),
      computeReviewCheck(session),
      computeQualityCheck(qualityReport),
      computeCiCheck(session),
      computeConflictCheck(session),
    ];

    const status = computeOverallStatus(checks);
    const computedAt = new Date().toISOString();

    const readiness: MergeReadiness = { sessionSlug: slug, status, checks, computedAt };
    stmtUpsert.run(slug, status, JSON.stringify(checks), computedAt);

    return readiness;
  }

  function summary(): ReadinessSummary {
    const sessions = ctx.sessions.list().filter(
      (s) => s.status !== "cancelled" && s.status !== "failed",
    );

    const bySession: { slug: string; status: MergeReadiness["status"] }[] = [];
    let ready = 0;
    let blocked = 0;
    let pending = 0;
    let unknown = 0;

    for (const session of sessions) {
      const row = stmtGet.get(session.slug);
      const status = row ? (row.status as MergeReadiness["status"]) : "unknown";
      bySession.push({ slug: session.slug, status });
      if (status === "ready") ready++;
      else if (status === "blocked") blocked++;
      else if (status === "pending") pending++;
      else unknown++;
    }

    return {
      total: sessions.length,
      ready,
      blocked,
      pending,
      unknown,
      bySession,
    };
  }

  return {
    api: { compute, summary },
    registerRoutes(app) {
      registerReadinessRoutes(app, ctx);
    },
  };
}
