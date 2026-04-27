import type Database from "better-sqlite3";
import type {
  Session,
  SessionStatus,
  SessionMode,
  ShipStage,
  AttentionFlag,
  QuickAction,
  SessionStats,
  PRSummary,
} from "@minions/shared";
import { nowIso } from "../../util/time.js";

interface SessionRow {
  slug: string;
  title: string;
  prompt: string;
  mode: string;
  status: string;
  ship_stage: string | null;
  repo_id: string | null;
  branch: string | null;
  base_branch: string | null;
  worktree_path: string | null;
  parent_slug: string | null;
  root_slug: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  pr_draft: number;
  pr_base: string | null;
  pr_head: string | null;
  pr_title: string | null;
  attention: string;
  quick_actions: string;
  stats_turns: number;
  stats_input_tokens: number;
  stats_output_tokens: number;
  stats_cache_read_tokens: number;
  stats_cache_creation_tokens: number;
  stats_cost_usd: number;
  stats_duration_ms: number;
  stats_tool_calls: number;
  provider: string;
  model_hint: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_turn_at: string | null;
  dag_id: string | null;
  dag_node_id: string | null;
  loop_id: string | null;
  variant_of: string | null;
  metadata: string;
}

function rowToSession(row: SessionRow, childSlugs: string[]): Session {
  let pr: PRSummary | undefined;
  if (row.pr_number && row.pr_url && row.pr_state && row.pr_base && row.pr_head && row.pr_title) {
    pr = {
      number: row.pr_number,
      url: row.pr_url,
      state: row.pr_state as PRSummary["state"],
      draft: row.pr_draft === 1,
      base: row.pr_base,
      head: row.pr_head,
      title: row.pr_title,
    };
  }

  return {
    slug: row.slug,
    title: row.title,
    prompt: row.prompt,
    mode: row.mode as SessionMode,
    status: row.status as SessionStatus,
    shipStage: row.ship_stage ? (row.ship_stage as ShipStage) : undefined,
    repoId: row.repo_id ?? undefined,
    branch: row.branch ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    parentSlug: row.parent_slug ?? undefined,
    rootSlug: row.root_slug ?? undefined,
    childSlugs,
    pr,
    attention: JSON.parse(row.attention) as AttentionFlag[],
    quickActions: JSON.parse(row.quick_actions) as QuickAction[],
    stats: {
      turns: row.stats_turns,
      inputTokens: row.stats_input_tokens,
      outputTokens: row.stats_output_tokens,
      cacheReadTokens: row.stats_cache_read_tokens,
      cacheCreationTokens: row.stats_cache_creation_tokens,
      costUsd: row.stats_cost_usd,
      durationMs: row.stats_duration_ms,
      toolCalls: row.stats_tool_calls,
    },
    provider: row.provider,
    modelHint: row.model_hint ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    lastTurnAt: row.last_turn_at ?? undefined,
    dagId: row.dag_id ?? undefined,
    dagNodeId: row.dag_node_id ?? undefined,
    loopId: row.loop_id ?? undefined,
    variantOf: row.variant_of ?? undefined,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

export class SessionRepo {
  private readonly stmtGet: Database.Statement;
  private readonly stmtList: Database.Statement;
  private readonly stmtListActive: Database.Statement;
  private readonly stmtListByLoop: Database.Statement;
  private readonly stmtChildren: Database.Statement;
  private readonly stmtInsert: Database.Statement;
  private readonly stmtUpdateStatus: Database.Statement;
  private readonly stmtMergeStats: Database.Statement;
  private readonly stmtSetShipStage: Database.Statement;
  private readonly stmtSetPr: Database.Statement;
  private readonly stmtSetAttention: Database.Statement;
  private readonly stmtSetQuickActions: Database.Statement;
  private readonly stmtUpdate: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.stmtGet = db.prepare(`SELECT * FROM sessions WHERE slug = ?`);
    this.stmtList = db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`);
    this.stmtListActive = db.prepare(
      `SELECT * FROM sessions WHERE status IN ('running','waiting_input') ORDER BY updated_at DESC`
    );
    this.stmtListByLoop = db.prepare(
      `SELECT * FROM sessions WHERE loop_id = ? ORDER BY created_at DESC`
    );
    this.stmtChildren = db.prepare(
      `SELECT slug FROM sessions WHERE parent_slug = ?`
    );
    this.stmtInsert = db.prepare(
      `INSERT INTO sessions(
        slug, title, prompt, mode, status, ship_stage, repo_id, branch, base_branch,
        worktree_path, parent_slug, root_slug, pr_number, pr_url, pr_state, pr_draft,
        pr_base, pr_head, pr_title, attention, quick_actions,
        stats_turns, stats_input_tokens, stats_output_tokens, stats_cache_read_tokens,
        stats_cache_creation_tokens, stats_cost_usd, stats_duration_ms, stats_tool_calls,
        provider, model_hint, created_at, updated_at, started_at, completed_at,
        last_turn_at, dag_id, dag_node_id, loop_id, variant_of, metadata
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`
    );
    this.stmtUpdateStatus = db.prepare(
      `UPDATE sessions SET status = ?, updated_at = ?, completed_at = ? WHERE slug = ?`
    );
    this.stmtMergeStats = db.prepare(
      `UPDATE sessions SET
        stats_turns = stats_turns + ?,
        stats_input_tokens = stats_input_tokens + ?,
        stats_output_tokens = stats_output_tokens + ?,
        stats_cache_read_tokens = stats_cache_read_tokens + ?,
        stats_cache_creation_tokens = stats_cache_creation_tokens + ?,
        stats_cost_usd = stats_cost_usd + ?,
        stats_duration_ms = stats_duration_ms + ?,
        stats_tool_calls = stats_tool_calls + ?,
        last_turn_at = ?,
        updated_at = ?
       WHERE slug = ?`
    );
    this.stmtSetShipStage = db.prepare(
      `UPDATE sessions SET ship_stage = ?, updated_at = ? WHERE slug = ?`
    );
    this.stmtSetPr = db.prepare(
      `UPDATE sessions SET pr_number = ?, pr_url = ?, pr_state = ?, pr_draft = ?,
       pr_base = ?, pr_head = ?, pr_title = ?, updated_at = ? WHERE slug = ?`
    );
    this.stmtSetAttention = db.prepare(
      `UPDATE sessions SET attention = ?, updated_at = ? WHERE slug = ?`
    );
    this.stmtSetQuickActions = db.prepare(
      `UPDATE sessions SET quick_actions = ?, updated_at = ? WHERE slug = ?`
    );
    this.stmtUpdate = db.prepare(
      `UPDATE sessions SET
        title = ?, branch = ?, base_branch = ?, worktree_path = ?,
        started_at = ?, updated_at = ?
       WHERE slug = ?`
    );
  }

  private childSlugs(slug: string): string[] {
    return (this.stmtChildren.all(slug) as { slug: string }[]).map((r) => r.slug);
  }

  get(slug: string): Session | null {
    const row = this.stmtGet.get(slug) as SessionRow | undefined;
    if (!row) return null;
    return rowToSession(row, this.childSlugs(slug));
  }

  list(): Session[] {
    return (this.stmtList.all() as SessionRow[]).map((r) => rowToSession(r, this.childSlugs(r.slug)));
  }

  listActive(): Session[] {
    return (this.stmtListActive.all() as SessionRow[]).map((r) => rowToSession(r, this.childSlugs(r.slug)));
  }

  listByLoop(loopId: string): Session[] {
    return (this.stmtListByLoop.all(loopId) as SessionRow[]).map((r) => rowToSession(r, this.childSlugs(r.slug)));
  }

  listChildren(parentSlug: string): Session[] {
    return (this.stmtChildren.all(parentSlug) as { slug: string }[])
      .map((r) => this.get(r.slug))
      .filter((s): s is Session => s !== null);
  }

  insert(session: Session): void {
    const pr = session.pr;
    this.stmtInsert.run(
      session.slug,
      session.title,
      session.prompt,
      session.mode,
      session.status,
      session.shipStage ?? null,
      session.repoId ?? null,
      session.branch ?? null,
      session.baseBranch ?? null,
      session.worktreePath ?? null,
      session.parentSlug ?? null,
      session.rootSlug ?? null,
      pr?.number ?? null,
      pr?.url ?? null,
      pr?.state ?? null,
      pr ? (pr.draft ? 1 : 0) : 0,
      pr?.base ?? null,
      pr?.head ?? null,
      pr?.title ?? null,
      JSON.stringify(session.attention),
      JSON.stringify(session.quickActions),
      session.stats.turns,
      session.stats.inputTokens,
      session.stats.outputTokens,
      session.stats.cacheReadTokens,
      session.stats.cacheCreationTokens,
      session.stats.costUsd,
      session.stats.durationMs,
      session.stats.toolCalls,
      session.provider,
      session.modelHint ?? null,
      session.createdAt,
      session.updatedAt,
      session.startedAt ?? null,
      session.completedAt ?? null,
      session.lastTurnAt ?? null,
      session.dagId ?? null,
      session.dagNodeId ?? null,
      session.loopId ?? null,
      session.variantOf ?? null,
      JSON.stringify(session.metadata)
    );
  }

  update(slug: string, patch: Partial<Pick<Session, "title" | "branch" | "baseBranch" | "worktreePath" | "startedAt">>): void {
    const current = this.get(slug);
    if (!current) return;
    this.stmtUpdate.run(
      patch.title ?? current.title,
      patch.branch ?? current.branch ?? null,
      patch.baseBranch ?? current.baseBranch ?? null,
      patch.worktreePath ?? current.worktreePath ?? null,
      patch.startedAt ?? current.startedAt ?? null,
      nowIso(),
      slug
    );
  }

  updateStatus(slug: string, status: SessionStatus): void {
    const terminal = ["completed", "failed", "cancelled"].includes(status);
    this.stmtUpdateStatus.run(status, nowIso(), terminal ? nowIso() : null, slug);
  }

  mergeStats(slug: string, delta: SessionStats): void {
    this.stmtMergeStats.run(
      delta.turns,
      delta.inputTokens,
      delta.outputTokens,
      delta.cacheReadTokens,
      delta.cacheCreationTokens,
      delta.costUsd,
      delta.durationMs,
      delta.toolCalls,
      nowIso(),
      nowIso(),
      slug
    );
  }

  setShipStage(slug: string, stage: ShipStage): void {
    this.stmtSetShipStage.run(stage, nowIso(), slug);
  }

  setPr(slug: string, pr: PRSummary | null): void {
    this.stmtSetPr.run(
      pr?.number ?? null,
      pr?.url ?? null,
      pr?.state ?? null,
      pr ? (pr.draft ? 1 : 0) : 0,
      pr?.base ?? null,
      pr?.head ?? null,
      pr?.title ?? null,
      nowIso(),
      slug
    );
  }

  setAttention(slug: string, flags: AttentionFlag[]): void {
    this.stmtSetAttention.run(JSON.stringify(flags), nowIso(), slug);
  }

  setQuickActions(slug: string, actions: QuickAction[]): void {
    this.stmtSetQuickActions.run(JSON.stringify(actions), nowIso(), slug);
  }
}
