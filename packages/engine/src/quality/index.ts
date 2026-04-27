import type { QualityReport } from "@minions/shared";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { loadGateConfig } from "./gates.js";
import { runChecks } from "./runner.js";
import { EngineError } from "../errors.js";

export interface QualitySubsystem {
  runForSession: (slug: string) => Promise<QualityReport>;
  getReport: (slug: string) => QualityReport | null;
}

interface QualityReportRow {
  session_slug: string;
  status: string;
  checks: string;
  created_at: string;
}

function rowToReport(row: QualityReportRow): QualityReport {
  return {
    sessionSlug: row.session_slug,
    status: row.status as QualityReport["status"],
    checks: JSON.parse(row.checks) as QualityReport["checks"],
    createdAt: row.created_at,
  };
}

export function createQualitySubsystem(deps: SubsystemDeps): SubsystemResult<QualitySubsystem> {
  const { db, log, ctx } = deps;

  const stmtGet = db.prepare<[string], QualityReportRow>(
    "SELECT * FROM quality_reports WHERE session_slug = ?",
  );
  const stmtUpsert = db.prepare<[string, string, string, string], void>(
    `INSERT INTO quality_reports (session_slug, status, checks, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_slug) DO UPDATE SET status=excluded.status, checks=excluded.checks, created_at=excluded.created_at`,
  );

  function getReport(slug: string): QualityReport | null {
    const row = stmtGet.get(slug);
    return row ? rowToReport(row) : null;
  }

  async function runForSession(slug: string): Promise<QualityReport> {
    const session = ctx.sessions.get(slug);
    if (!session) throw new EngineError("not_found", `Session ${slug} not found`);

    const worktreePath = session.worktreePath;
    if (!worktreePath) {
      const report: QualityReport = {
        sessionSlug: slug,
        status: "pending",
        checks: [],
        createdAt: new Date().toISOString(),
      };
      stmtUpsert.run(slug, report.status, JSON.stringify(report.checks), report.createdAt);
      return report;
    }

    const runtimeValues = ctx.runtime.effective();
    const timeoutMs = typeof runtimeValues["qualityTimeoutMs"] === "number"
      ? runtimeValues["qualityTimeoutMs"]
      : 300_000;

    const configs = await loadGateConfig(worktreePath, log);
    const { checks, status } = await runChecks(configs, worktreePath, timeoutMs);

    const report: QualityReport = {
      sessionSlug: slug,
      status,
      checks,
      createdAt: new Date().toISOString(),
    };

    stmtUpsert.run(slug, report.status, JSON.stringify(report.checks), report.createdAt);

    const fresh = ctx.sessions.get(slug);
    if (fresh) {
      ctx.bus.emit({ kind: "session_updated", session: fresh });
    }

    log.info("quality run complete", { slug, status, checkCount: checks.length });
    return report;
  }

  return {
    api: { runForSession, getReport },
  };
}
