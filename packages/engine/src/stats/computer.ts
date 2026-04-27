import type Database from "better-sqlite3";
import type { GlobalStats, ModeStats, RecentStats, RecentSession, SessionMode } from "@minions/shared";

const ALL_MODES: SessionMode[] = [
  "task", "dag-task", "plan", "think", "review", "ship",
  "rebase-resolver", "loop",
];

interface StatsRow {
  mode: string;
  status: string;
  stats_turns: number;
  stats_input_tokens: number;
  stats_output_tokens: number;
  stats_cache_read_tokens: number;
  stats_cache_creation_tokens: number;
  stats_cost_usd: number;
  stats_duration_ms: number;
  stats_tool_calls: number;
}

interface RecentRow {
  slug: string;
  title: string;
  mode: string;
  status: string;
  updated_at: string;
  stats_cost_usd: number;
}

export class StatsComputer {
  private readonly startedAt = new Date().toISOString();
  private readonly startedAtMs = Date.now();

  constructor(private readonly db: Database.Database) {}

  global(): GlobalStats {
    const rows = this.db
      .prepare(
        `SELECT mode, status,
           stats_turns, stats_input_tokens, stats_output_tokens,
           stats_cache_read_tokens, stats_cache_creation_tokens,
           stats_cost_usd, stats_duration_ms, stats_tool_calls
         FROM sessions`
      )
      .all() as StatsRow[];

    let sessions = 0;
    let running = 0;
    let waiting = 0;
    let completed = 0;
    let failed = 0;
    let turns = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let costUsd = 0;
    let toolCalls = 0;

    for (const r of rows) {
      sessions++;
      if (r.status === "running") running++;
      if (r.status === "waiting_input") waiting++;
      if (r.status === "completed") completed++;
      if (r.status === "failed") failed++;
      turns += r.stats_turns;
      inputTokens += r.stats_input_tokens;
      outputTokens += r.stats_output_tokens;
      cacheReadTokens += r.stats_cache_read_tokens;
      cacheCreationTokens += r.stats_cache_creation_tokens;
      costUsd += r.stats_cost_usd;
      toolCalls += r.stats_tool_calls;
    }

    return {
      totals: {
        sessions,
        running,
        waiting,
        completed,
        failed,
        turns,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        costUsd,
        toolCalls,
      },
      uptimeSec: Math.floor((Date.now() - this.startedAtMs) / 1000),
    };
  }

  modes(): ModeStats {
    const rows = this.db
      .prepare(`SELECT mode, status, stats_cost_usd FROM sessions`)
      .all() as { mode: string; status: string; stats_cost_usd: number }[];

    const result = {} as ModeStats;
    for (const mode of ALL_MODES) {
      result[mode] = { total: 0, running: 0, completed: 0, failed: 0, costUsd: 0 };
    }

    for (const r of rows) {
      const m = r.mode as SessionMode;
      if (!result[m]) {
        result[m] = { total: 0, running: 0, completed: 0, failed: 0, costUsd: 0 };
      }
      const bucket = result[m];
      if (!bucket) continue;
      bucket.total++;
      if (r.status === "running") bucket.running++;
      if (r.status === "completed") bucket.completed++;
      if (r.status === "failed") bucket.failed++;
      bucket.costUsd += r.stats_cost_usd;
    }

    return result;
  }

  recent(hours = 24): RecentStats {
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT slug, title, mode, status, updated_at, stats_cost_usd
         FROM sessions
         WHERE updated_at >= ?
         ORDER BY updated_at DESC
         LIMIT 100`
      )
      .all(since) as RecentRow[];

    const sessions: RecentSession[] = rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      mode: r.mode as SessionMode,
      status: r.status as RecentSession["status"],
      updatedAt: r.updated_at,
      costUsd: r.stats_cost_usd,
    }));

    return { sessions, windowHours: hours };
  }

  promText(): string {
    const g = this.global();
    const uptimeSec = g.uptimeSec;
    const lines: string[] = [
      `# HELP sessions_total Total sessions ever created`,
      `# TYPE sessions_total counter`,
      `sessions_total ${g.totals.sessions}`,
      `# HELP sessions_running Currently running sessions`,
      `# TYPE sessions_running gauge`,
      `sessions_running ${g.totals.running}`,
      `# HELP sessions_failed_total Total sessions that ended in failed status`,
      `# TYPE sessions_failed_total counter`,
      `sessions_failed_total ${g.totals.failed}`,
      `# HELP tokens_input_total Total input tokens consumed`,
      `# TYPE tokens_input_total counter`,
      `tokens_input_total ${g.totals.inputTokens}`,
      `# HELP tokens_output_total Total output tokens produced`,
      `# TYPE tokens_output_total counter`,
      `tokens_output_total ${g.totals.outputTokens}`,
      `# HELP cost_usd_total Total cost in USD`,
      `# TYPE cost_usd_total counter`,
      `cost_usd_total ${g.totals.costUsd.toFixed(6)}`,
      `# HELP uptime_seconds Engine uptime in seconds`,
      `# TYPE uptime_seconds gauge`,
      `uptime_seconds ${uptimeSec}`,
      "",
    ];
    return lines.join("\n");
  }
}
