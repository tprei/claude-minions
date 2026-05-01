import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type {
  Session,
  SessionStatus,
  SessionMode,
  SessionWithTranscript,
  TranscriptEvent,
  CreateSessionRequest,
  Checkpoint,
  Screenshot,
  WorkspaceDiff,
  PermissionTier,
  AttentionFlag,
} from "@minions/shared";
import type { EventBus } from "../bus/eventBus.js";
import type { Logger } from "../logger.js";
import type { EngineContext } from "../context.js";
import { EngineError } from "../errors.js";
import { newSlug, newEventId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { ensureDir } from "../util/fs.js";
import { getProvider } from "../providers/registry.js";
import type { ProviderHandle } from "../providers/provider.js";
import { READ_ONLY_STAGES } from "../ship/stages.js";
import { TranscriptCollector } from "./transcriptCollector.js";
import { ReplyQueue } from "./replyQueue.js";
import {
  sanitizeAttachmentName,
  assertAllowedMime,
  assertWithinSize,
} from "./attachmentValidator.js";
import { Screenshots } from "./screenshots.js";
import { Checkpoints } from "./checkpoints.js";
import { writeSessionSettings } from "./writeSessionSettings.js";
import { computeDiff } from "./diff.js";
import { rowToSession, rowToTranscriptEvent, type SessionRow, type TranscriptRow } from "./mapper.js";
import { inferBucket } from "./inferBucket.js";
import { SessionRepo, type ListSessionsOptions, type ListSessionsResult } from "../store/repos/sessionRepo.js";
import type { AutomationJobRepo } from "../store/repos/automationJobRepo.js";
import { workspacePaths } from "../workspace/paths.js";
import { ensureBareClone } from "../workspace/cloner.js";
import { addWorktree, removeWorktree, initScratchRepo } from "../workspace/worktree.js";
import { linkDeps } from "../workspace/depsCache.js";
import { injectAssets } from "../workspace/assetInjector.js";
import { KeyedMutex } from "../util/mutex.js";
import {
  checkAdmission,
  classifyMode,
  emptyRunningByClass,
  type RunningByClass,
} from "./admission.js";
import { enqueueSessionSpawnRetry } from "../automation/handlers/sessionSpawnRetry.js";

interface RepoRow {
  id: string;
  label: string;
  remote: string | null;
  default_branch: string;
}

export function derivePermissionTier(
  mode: SessionMode,
  shipStage: import("@minions/shared").ShipStage | null,
): PermissionTier {
  if (mode === "think") {
    return "read";
  }
  if (mode === "verify-child") {
    return "read";
  }
  if (mode === "ship") {
    const stage = shipStage ?? "think";
    return READ_ONLY_STAGES.has(stage) ? "read" : "full";
  }
  if (mode === "dag-task") {
    return "worktree";
  }
  return "full";
}

function resolveBridgeScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const enginePkgRoot = path.resolve(here, "..", "..");
  const distBridge = path.join(enginePkgRoot, "dist", "memory", "mcpBridge.mjs");
  const srcBridge = path.join(enginePkgRoot, "src", "memory", "mcpBridge.mjs");
  if (fsSync.existsSync(distBridge)) return distBridge;
  return srcBridge;
}

interface ProviderStateRow {
  session_slug: string;
  provider: string;
  external_id: string | null;
  last_seq: number;
  last_turn: number;
  data: string;
  updated_at: string;
}

export interface RegistryDeps {
  db: Database.Database;
  bus: EventBus;
  log: Logger;
  workspaceDir: string;
  ctx: EngineContext;
  automationRepo?: AutomationJobRepo;
}

export interface SpawnPendingResult {
  spawned: boolean;
  reason?: string;
}

const DEFAULT_SPAWN_TIMEOUT_MS = 120_000;
export const STUCK_PENDING_GRACE_MS = 180_000;
const STUCK_PENDING_SWEEP_INTERVAL_MS = 30_000;

let spawnTimeoutMs = DEFAULT_SPAWN_TIMEOUT_MS;

export function __setSpawnTimeoutMsForTests(ms: number | null): void {
  spawnTimeoutMs = ms ?? DEFAULT_SPAWN_TIMEOUT_MS;
}

async function tryGetGithubToken(ctx: EngineContext): Promise<string | null> {
  if (!ctx.github || typeof ctx.github.enabled !== "function" || !ctx.github.enabled()) {
    return null;
  }
  try {
    return await ctx.github.getToken();
  } catch {
    return null;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class SessionRegistry {
  private handles = new Map<string, ProviderHandle>();
  private readonly collector: TranscriptCollector;
  private readonly replyQueue: ReplyQueue;
  private readonly screenshots: Screenshots;
  private readonly checkpointStore: Checkpoints;
  private readonly paths: ReturnType<typeof workspacePaths>;
  private readonly repo: SessionRepo;
  private readonly slugMutex = new KeyedMutex();

  private readonly insertSession: Database.Statement;
  private readonly updateSession: Database.Statement;
  private readonly getSession: Database.Statement;
  private readonly listSessions: Database.Statement;
  private readonly listChildren: Database.Statement;
  private readonly listActiveSession: Database.Statement;
  private readonly listAdmittedSession: Database.Statement;
  private readonly listStuckPending: Database.Statement;
  private readonly getProviderState: Database.Statement;
  private readonly upsertProviderState: Database.Statement;
  private readonly listTranscript: Database.Statement;
  private readonly listTranscriptSince: Database.Statement;
  private readonly updateSessionStatus: Database.Statement;
  private readonly getRepo: Database.Statement;
  private stuckPendingSweepHandle: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: RegistryDeps) {
    const { db, bus, log, workspaceDir } = deps;

    this.paths = workspacePaths(workspaceDir);

    this.repo = new SessionRepo(db);
    this.collector = new TranscriptCollector({ db, bus, log, ctx: deps.ctx });
    this.replyQueue = new ReplyQueue(db);
    this.screenshots = new Screenshots({
      db,
      bus,
      screenshotsDir: (slug) => this.paths.screenshots(slug),
    });
    this.checkpointStore = new Checkpoints(db);

    this.insertSession = db.prepare(`
      INSERT INTO sessions(
        slug, title, prompt, mode, status, ship_stage, repo_id, branch, base_branch,
        worktree_path, parent_slug, root_slug, pr_number, pr_url, pr_state, pr_draft,
        pr_base, pr_head, pr_title, attention, quick_actions,
        stats_turns, stats_input_tokens, stats_output_tokens,
        stats_cache_read_tokens, stats_cache_creation_tokens,
        stats_cost_usd, stats_duration_ms, stats_tool_calls,
        provider, model_hint, created_at, updated_at, started_at, completed_at,
        last_turn_at, dag_id, dag_node_id, loop_id, variant_of, metadata,
        permission_tier, bucket, cost_budget_usd
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?
      )
    `);

    this.updateSession = db.prepare(`
      UPDATE sessions SET
        status = ?, updated_at = ?, started_at = COALESCE(started_at, ?),
        completed_at = ?, worktree_path = COALESCE(?, worktree_path),
        branch = COALESCE(?, branch)
      WHERE slug = ?
    `);

    this.updateSessionStatus = db.prepare(`
      UPDATE sessions SET status = ?, updated_at = ?, completed_at = ?
      WHERE slug = ?
    `);

    this.getSession = db.prepare(`SELECT * FROM sessions WHERE slug = ?`);
    this.listSessions = db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`);
    this.listChildren = db.prepare(`SELECT slug FROM sessions WHERE parent_slug = ?`);
    this.listActiveSession = db.prepare(
      `SELECT * FROM sessions WHERE status IN ('running', 'waiting_input')`,
    );
    this.listAdmittedSession = db.prepare(
      `SELECT mode FROM sessions
       WHERE status IN ('running', 'waiting_input')
          OR (status = 'pending' AND created_at >= ?)`,
    );
    this.listStuckPending = db.prepare(
      `SELECT slug FROM sessions WHERE status = 'pending' AND created_at < ?`,
    );
    this.getProviderState = db.prepare(`SELECT * FROM provider_state WHERE session_slug = ?`);
    this.upsertProviderState = db.prepare(`
      INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_slug) DO UPDATE SET
        external_id = COALESCE(excluded.external_id, provider_state.external_id),
        updated_at = excluded.updated_at
    `);
    this.listTranscript = db.prepare(
      `SELECT * FROM transcript_events WHERE session_slug = ? ORDER BY seq ASC`,
    );
    this.listTranscriptSince = db.prepare(
      `SELECT * FROM transcript_events WHERE session_slug = ? AND seq > ? ORDER BY seq ASC`,
    );
    this.getRepo = db.prepare(`SELECT * FROM repos WHERE id = ?`);

    this.startStuckPendingSweep();
  }

  private startStuckPendingSweep(): void {
    if (this.stuckPendingSweepHandle !== null) return;
    this.stuckPendingSweepHandle = setInterval(() => {
      try {
        this.sweepStuckPending();
      } catch (err) {
        this.deps.log.error("stuck-pending sweep failed", { err: String(err) });
      }
    }, STUCK_PENDING_SWEEP_INTERVAL_MS);
    if (typeof this.stuckPendingSweepHandle.unref === "function") {
      this.stuckPendingSweepHandle.unref();
    }
  }

  stopStuckPendingSweep(): void {
    if (this.stuckPendingSweepHandle !== null) {
      clearInterval(this.stuckPendingSweepHandle);
      this.stuckPendingSweepHandle = null;
    }
  }

  sweepStuckPending(): number {
    const cutoffIso = new Date(Date.now() - STUCK_PENDING_GRACE_MS).toISOString();
    const rows = this.listStuckPending.all(cutoffIso) as Array<{ slug: string }>;
    let swept = 0;
    for (const row of rows) {
      const slug = row.slug;
      this.deps.log.warn("sweeping stuck pending session", {
        slug,
        graceMs: STUCK_PENDING_GRACE_MS,
      });
      try {
        this.failSessionWithAttention(
          slug,
          `spawn timeout — session stuck in pending for >${Math.round(STUCK_PENDING_GRACE_MS / 1000)}s`,
        );
        this.deps.ctx.audit.record(
          "system",
          "session.spawn.timeout",
          { kind: "session", id: slug },
          { graceMs: STUCK_PENDING_GRACE_MS },
        );
        swept += 1;
      } catch (err) {
        this.deps.log.error("failed to sweep stuck pending session", {
          slug,
          err: String(err),
        });
      }
    }
    return swept;
  }

  private failSessionWithAttention(slug: string, message: string): void {
    const row = this.getSessionRow(slug);
    if (!row) return;

    const now = nowIso();
    this.updateSessionStatus.run("failed", now, now, slug);

    const session = this.buildSession(this.getSessionRow(slug)!);
    const next: AttentionFlag[] = [
      ...session.attention,
      { kind: "manual_intervention", message, raisedAt: now },
    ];
    this.repo.setAttention(slug, next);

    const updatedRow = this.getSessionRow(slug)!;
    this.emitUpdated(this.buildSession(updatedRow));
  }

  private getSessionRow(slug: string): SessionRow | null {
    return (this.getSession.get(slug) as SessionRow | undefined) ?? null;
  }

  private buildSession(row: SessionRow): Session {
    const children = (this.listChildren.all(row.slug) as Array<{ slug: string }>).map((r) => r.slug);
    return rowToSession(row, children);
  }

  private emitUpdated(session: Session): void {
    this.deps.bus.emit({ kind: "session_updated", session });
  }

  get(slug: string): Session | null {
    const row = this.getSessionRow(slug);
    if (!row) return null;
    return this.buildSession(row);
  }

  list(): Session[] {
    const rows = this.listSessions.all() as SessionRow[];
    return rows.map((r) => this.buildSession(r));
  }

  listPaged(opts: ListSessionsOptions): ListSessionsResult {
    return this.repo.listPaged(opts);
  }

  listWithTranscript(): SessionWithTranscript[] {
    return this.list().map((s) => ({
      ...s,
      transcript: this.transcript(s.slug),
    }));
  }

  transcript(slug: string, sinceSeq?: number): TranscriptEvent[] {
    const rows = sinceSeq === undefined
      ? (this.listTranscript.all(slug) as TranscriptRow[])
      : (this.listTranscriptSince.all(slug, sinceSeq) as TranscriptRow[]);
    return rows.map(rowToTranscriptEvent);
  }

  updateBucket(slug: string, bucket: import("@minions/shared").SessionBucket | null): void {
    const row = this.getSessionRow(slug);
    if (!row) throw new EngineError("not_found", `Session ${slug} not found`);
    this.repo.setBucket(slug, bucket);
    this.emitUpdated(this.buildSession(this.getSessionRow(slug)!));
  }

  private countRunningByClass(): RunningByClass {
    const counts = emptyRunningByClass();
    const cutoffIso = new Date(Date.now() - STUCK_PENDING_GRACE_MS).toISOString();
    const rows = this.listAdmittedSession.all(cutoffIso) as Array<{ mode: string }>;
    for (const row of rows) {
      const cls = classifyMode(row.mode as SessionMode);
      counts[cls] += 1;
    }
    return counts;
  }

  async create(req: CreateSessionRequest): Promise<Session> {
    const { db, bus, log, ctx, workspaceDir } = this.deps;

    const slug = req.slug ? this.reserveSuggestedSlug(req.slug) : newSlug();
    const now = nowIso();
    const mode: SessionMode = req.mode ?? "task";
    const bucket = req.bucket ?? inferBucket({ prompt: req.prompt, mode, metadata: req.metadata });

    const cls = classifyMode(mode);
    const runningByClass = this.countRunningByClass();
    const decision = checkAdmission(
      cls,
      runningByClass,
      ctx.runtime.effective(),
      ctx.resource.latest(),
    );
    const isAutonomousClass =
      cls === "autonomous_loop" || cls === "dag_task" || cls === "background";
    const isResourceDenial =
      !decision.admit && decision.reason.startsWith("resource:");
    const shouldQueueOnPressure =
      !decision.admit &&
      isResourceDenial &&
      isAutonomousClass &&
      this.deps.automationRepo !== undefined;
    if (!decision.admit && !shouldQueueOnPressure) {
      ctx.audit.record(
        "system",
        "session.create.denied",
        { kind: "session", id: slug },
        { class: cls, reason: decision.reason, runningByClass },
      );
      throw new EngineError("conflict", `Admission denied: ${decision.reason}`, {
        class: cls,
        runningByClass,
      });
    }
    const providerName = ctx.env.provider;
    const title = req.title ?? req.prompt.slice(0, 80);
    const initialShipStage: import("@minions/shared").ShipStage | null =
      mode === "ship" ? "think" : null;
    const permissionTier = derivePermissionTier(mode, initialShipStage);

    let costBudgetUsd: number | undefined = req.costBudgetUsd;
    if (costBudgetUsd === undefined) {
      const def = ctx.runtime.effective()["defaultSessionBudgetUsd"];
      if (typeof def === "number" && def > 0) {
        costBudgetUsd = def;
      }
    }

    const reqMetadata: Record<string, unknown> = { ...(req.metadata ?? {}) };
    if (
      mode === "task" &&
      !("selfHealCi" in reqMetadata) &&
      ctx.runtime.effective()["defaultSelfHealCi"] === true
    ) {
      reqMetadata["selfHealCi"] = true;
    }

    // Hold the per-slug mutex from the moment we insert the session row through
    // the end of setupAndSpawn (and the final buildSession read). delete() takes
    // the same mutex, so a concurrent cleanup cannot drop the parent row (and
    // CASCADE its children) while we are still issuing FK-bearing inserts
    // (provider_state, transcript_events) for this slug.
    return this.slugMutex.run(slug, async () => {
      this.insertSession.run(
        slug, title, req.prompt, mode, "pending",
        null, req.repoId ?? null, null, req.baseBranch ?? null,
        null, req.parentSlug ?? null, req.parentSlug ? (this.getRootSlug(req.parentSlug) ?? req.parentSlug) : null,
        null, null, null, 0, null, null, null,
        "[]", "[]",
        0, 0, 0, 0, 0, 0, 0, 0,
        providerName, req.modelHint ?? null,
        now, now, null, null, null,
        null, null, null, null,
        JSON.stringify(reqMetadata),
        permissionTier,
        bucket,
        costBudgetUsd ?? null,
      );

      if (mode === "ship") {
        this.deps.db.prepare(`
          INSERT INTO ship_state(session_slug, stage, notes, updated_at)
          VALUES (?, 'think', '[]', ?)
          ON CONFLICT(session_slug) DO NOTHING
        `).run(slug, now);
        this.deps.db.prepare(
          `UPDATE sessions SET ship_stage = 'think', updated_at = ? WHERE slug = ?`,
        ).run(now, slug);
      }

      const sessionRow = this.getSessionRow(slug)!;
      const session = this.buildSession(sessionRow);
      bus.emit({ kind: "session_created", session });

      const seedEventId = newEventId();
      const seedBody = JSON.stringify({ text: req.prompt, source: "operator" });
      try {
        db.prepare(
          `INSERT INTO transcript_events(id, session_slug, seq, turn, kind, body, timestamp)
           VALUES (?, ?, 0, 0, 'user_message', ?, ?)`,
        ).run(seedEventId, slug, seedBody, now);
      } catch (err) {
        log.error("create: seed transcript_event insert failed", {
          slug,
          table: "transcript_events",
          sessionExists: !!this.getSessionRow(slug),
          err: String(err),
        });
        throw err;
      }
      const seedEvent = rowToTranscriptEvent({
        id: seedEventId,
        session_slug: slug,
        seq: 0,
        turn: 0,
        kind: "user_message",
        body: seedBody,
        timestamp: now,
      });
      bus.emit({ kind: "transcript_event", sessionSlug: slug, event: seedEvent });

      ctx.audit.record("operator", "session.create", { kind: "session", id: slug });

      if (shouldQueueOnPressure) {
        ctx.audit.record(
          "system",
          "session.create.deferred",
          { kind: "session", id: slug },
          { class: cls, reason: decision.admit ? null : decision.reason, runningByClass },
        );
        enqueueSessionSpawnRetry(this.deps.automationRepo!, slug, 0);
        return this.buildSession(this.getSessionRow(slug)!);
      }

      try {
        await withTimeout(
          this.setupAndSpawn(slug, req, session, providerName),
          spawnTimeoutMs,
          () =>
            new EngineError(
              "upstream",
              `setupAndSpawn timed out after ${spawnTimeoutMs}ms`,
              { provider: providerName, sessionSlug: slug, op: "setup" },
            ),
        );
      } catch (err) {
        log.error("session setup failed", { slug, err: String(err) });
        this.failSessionWithAttention(slug, `Spawn failed: ${String(err)}`);
        throw err;
      }

      if (req.parentSlug) {
        const parent = this.get(req.parentSlug);
        if (parent && parent.mode === "think") {
          ctx.audit.record(
            "operator",
            "spawn_from_think",
            { kind: "session", id: slug },
            { parentSlug: parent.slug, mode: req.mode ?? "task" },
          );
        }
      }

      return this.buildSession(this.getSessionRow(slug)!);
    });
  }

  async spawnPending(slug: string): Promise<SpawnPendingResult> {
    return this.slugMutex.run(slug, async () => {
      const row = this.getSessionRow(slug);
      if (!row) return { spawned: false, reason: "not_found" };
      const status = row.status as SessionStatus;
      if (status !== "pending") return { spawned: false, reason: `status:${status}` };

      const mode = row.mode as SessionMode;
      const cls = classifyMode(mode);
      const decision = checkAdmission(
        cls,
        this.countRunningByClass(),
        this.deps.ctx.runtime.effective(),
        this.deps.ctx.resource.latest(),
      );
      if (!decision.admit) {
        return { spawned: false, reason: decision.reason };
      }

      const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      const reconstructedReq: CreateSessionRequest = {
        prompt: row.prompt,
        mode,
        title: row.title,
        slug: row.slug,
        repoId: row.repo_id ?? undefined,
        baseBranch: row.base_branch ?? undefined,
        parentSlug: row.parent_slug ?? undefined,
        modelHint: row.model_hint ?? undefined,
        metadata,
        bucket: (row.bucket ?? undefined) as import("@minions/shared").SessionBucket | undefined,
        costBudgetUsd: row.cost_budget_usd ?? undefined,
      };
      const session = this.buildSession(row);
      const providerName = row.provider;

      try {
        await withTimeout(
          this.setupAndSpawn(slug, reconstructedReq, session, providerName),
          spawnTimeoutMs,
          () =>
            new EngineError(
              "upstream",
              `setupAndSpawn timed out after ${spawnTimeoutMs}ms`,
              { provider: providerName, sessionSlug: slug, op: "setup" },
            ),
        );
      } catch (err) {
        this.deps.log.error("spawnPending: setup failed", { slug, err: String(err) });
        this.failSessionWithAttention(slug, `Spawn failed: ${String(err)}`);
        throw err;
      }

      return { spawned: true };
    });
  }

  private getRootSlug(parentSlug: string): string | null {
    const row = this.getSessionRow(parentSlug);
    if (!row) return null;
    return row.root_slug ?? parentSlug;
  }

  private reserveSuggestedSlug(suggested: string): string {
    const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    const MAX_LEN = 40;

    if (
      suggested.length < 1 ||
      suggested.length > MAX_LEN ||
      !SLUG_PATTERN.test(suggested)
    ) {
      throw new EngineError("bad_request", `Invalid slug: ${suggested}`, {
        slug: suggested,
      });
    }

    if (this.getSessionRow(suggested) === null) {
      return suggested;
    }

    for (let n = 2; n <= 50; n += 1) {
      const suffix = `-${n}`;
      let base = suggested;
      if (base.length + suffix.length > MAX_LEN) {
        base = base.slice(0, MAX_LEN - suffix.length);
        if (base.endsWith("-")) base = base.slice(0, -1);
      }
      const candidate = `${base}${suffix}`;
      if (this.getSessionRow(candidate) === null) {
        return candidate;
      }
    }

    throw new EngineError(
      "conflict",
      `Could not allocate unique slug from suggestion: ${suggested}`,
      { slug: suggested },
    );
  }

  private async writeMcpConfig(slug: string, _worktreePath: string): Promise<string> {
    const env = this.deps.ctx.env;
    // The MCP config embeds MINIONS_TOKEN. It must live outside the worktree
    // so an agent's `git add . && git commit` cannot capture and (if the
    // branch is later pushed) leak the bearer token to a remote.
    const mcpConfigDir = path.join(this.deps.workspaceDir, "mcp-configs");
    await ensureDir(mcpConfigDir);
    const mcpConfigPath = path.join(mcpConfigDir, `${slug}.json`);
    const host = env.host === "0.0.0.0" ? "127.0.0.1" : env.host;
    const config = {
      mcpServers: {
        "minions-memory": {
          command: "node",
          args: [resolveBridgeScript()],
          env: {
            MINIONS_SESSION_SLUG: slug,
            MINIONS_TOKEN: env.token,
            MINIONS_URL: `http://${host}:${env.port}`,
          },
        },
      },
    };
    await fs.writeFile(mcpConfigPath, JSON.stringify(config, null, 2), "utf8");
    return mcpConfigPath;
  }

  private async setupAndSpawn(
    slug: string,
    req: CreateSessionRequest,
    _session: Session,
    providerName: string,
  ): Promise<void> {
    const { log, ctx, workspaceDir } = this.deps;
    const paths = this.paths;

    log.info("setupAndSpawn:start", { slug, provider: providerName });

    let worktreePath: string;
    let branch: string | undefined;

    if (req.repoId) {
      const repoRow = this.getRepo.get(req.repoId) as RepoRow | undefined;
      if (!repoRow) {
        throw new EngineError("not_found", `Repo ${req.repoId} not found`);
      }

      if (repoRow.remote) {
        await ensureBareClone(req.repoId, repoRow.remote, paths.repos, log);
        log.info("setupAndSpawn:ensureBareClone done", { slug });
      }

      const result = await addWorktree(
        paths.repos,
        workspaceDir,
        req.repoId,
        slug,
        req.baseBranch ?? repoRow.default_branch,
        log,
      );
      worktreePath = result.worktreePath;
      branch = result.branch;
      log.info("setupAndSpawn:addWorktree done", { slug, worktreePath, branch });

      await linkDeps(req.repoId, worktreePath, paths.depsCache(req.repoId), log);
      log.info("setupAndSpawn:linkDeps done", { slug });
    } else {
      worktreePath = paths.worktree(slug);
      await initScratchRepo(worktreePath, slug, log);
      log.info("setupAndSpawn:initScratchRepo done", { slug, worktreePath });
    }

    await ensureDir(path.join(worktreePath, ".minions"));
    await ensureDir(path.join(worktreePath, ".minions", "screenshots"));
    await ensureDir(paths.uploads(slug));

    await injectAssets(worktreePath);
    log.info("setupAndSpawn:injectAssets done", { slug });

    if (req.attachments && req.attachments.length > 0) {
      const sessionUploads = paths.uploads(slug);
      await ensureDir(sessionUploads);
      const globalUploads = path.join(workspaceDir, "uploads");
      for (const att of req.attachments) {
        const dst = path.join(sessionUploads, att.name);
        if (att.url) {
          if (!att.url.startsWith("/api/uploads/")) {
            throw new EngineError("bad_request", "external attachment URLs not supported");
          }
          const filename = att.url.slice("/api/uploads/".length);
          if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
            throw new EngineError("bad_request", "invalid attachment url");
          }
          await fs.copyFile(path.join(globalUploads, filename), dst);
        } else if (att.dataBase64) {
          // transitional — T16 prefers url
          await fs.writeFile(dst, Buffer.from(att.dataBase64, "base64"));
        } else {
          throw new EngineError("bad_request", "attachment must include url or dataBase64");
        }
      }
    }

    const preamble = ctx.memory.renderPreamble(req.repoId);

    const provider = getProvider(providerName);

    this.deps.db.prepare(
      `UPDATE sessions SET worktree_path = ?, branch = ?, updated_at = ? WHERE slug = ?`,
    ).run(worktreePath, branch ?? null, nowIso(), slug);

    const mode: SessionMode = req.mode ?? "task";
    const initialShipStage: import("@minions/shared").ShipStage = "think";
    const permissionTier = derivePermissionTier(
      mode,
      mode === "ship" ? initialShipStage : null,
    );

    const homeDir = paths.home(providerName);
    await ensureDir(homeDir);
    await writeSessionSettings(homeDir, worktreePath, permissionTier);

    const env: Record<string, string> = {
      HOME: homeDir,
      MINIONS_SESSION_SLUG: slug,
      MINIONS_SLUG: slug,
      MINIONS_WORKTREE: worktreePath,
      MINIONS_UPLOADS_DIR: paths.uploads(slug),
      MINIONS_CLAUDE_HOME: homeDir,
    };
    if (process.env["ANTHROPIC_API_KEY"]) {
      env["ANTHROPIC_API_KEY"] = process.env["ANTHROPIC_API_KEY"];
    }
    const ghToken = await tryGetGithubToken(this.deps.ctx);
    if (ghToken) {
      env["GH_TOKEN"] = ghToken;
      env["GITHUB_TOKEN"] = ghToken;
    }

    const mcpConfigPath = await this.writeMcpConfig(slug, worktreePath);
    log.info("setupAndSpawn:writeMcpConfig done", { slug });

    log.info("setupAndSpawn:provider.spawn invoking", { slug, provider: providerName });
    let handle: ProviderHandle;
    try {
      handle = await provider.spawn({
        sessionSlug: slug,
        worktree: worktreePath,
        prompt: req.prompt,
        modelHint: req.modelHint,
        env,
        preamble,
        mcpConfigPath,
        permissionTier,
      });
    } catch (err) {
      log.error("setupAndSpawn:provider.spawn failed", { slug, err: String(err) });
      throw err;
    }
    log.info("setupAndSpawn:provider.spawn returned", {
      slug,
      externalId: handle.externalId ?? null,
    });

    this.handles.set(slug, handle);

    try {
      if (handle.externalId) {
        this.upsertProviderState.run(slug, providerName, handle.externalId, 0, 0, "{}", nowIso());
      } else {
        this.upsertProviderState.run(slug, providerName, null, 0, 0, "{}", nowIso());
      }
    } catch (err) {
      log.error("setupAndSpawn: insert into provider_state failed", {
        slug,
        table: "provider_state",
        sessionExists: !!this.getSessionRow(slug),
        err: String(err),
      });
      throw err;
    }

    this.updateSession.run("running", nowIso(), nowIso(), null, worktreePath, branch ?? null, slug);
    const updatedRow = this.getSessionRow(slug)!;
    this.emitUpdated(this.buildSession(updatedRow));

    this.pipeHandle(slug, handle, providerName);
  }

  private pipeHandle(
    slug: string,
    handle: ProviderHandle,
    providerName: string,
    startTurn = 0,
  ): void {
    const { log, ctx } = this.deps;

    const durableState = this.getProviderState.get(slug) as ProviderStateRow | undefined;
    const effectiveTurn = startTurn === 0 && (durableState?.last_turn ?? 0) > 0
      ? durableState!.last_turn
      : startTurn;

    const onExternalId = (externalId: string) => {
      this.upsertProviderState.run(slug, providerName, externalId, 0, 0, "{}", nowIso());
    };

    this.collector.collect(slug, handle, onExternalId, effectiveTurn).catch((err) => {
      log.error("transcript collector error", { slug, err: String(err) });
    });

    handle.waitForExit().then(async ({ code, signal: _signal }) => {
      this.handles.delete(slug);

      const row = this.getSessionRow(slug);
      if (!row) return;
      const current = row.status as SessionStatus;

      if (current === "cancelled") {
        return;
      }

      const finalStatus: SessionStatus = code === 0 ? "completed" : "failed";

      // Commit the terminal status BEFORE downstream handlers fire so they read
      // the true final state via ctx.sessions.get(). If we deferred the write,
      // dag-terminal would see the pre-terminal 'running' value and mark the
      // node failed with "session terminated with status: running".
      const now = nowIso();
      this.updateSessionStatus.run(finalStatus, now, now, slug);
      this.emitUpdated(this.buildSession(this.getSessionRow(slug)!));

      try {
        await ctx.dags.onSessionTerminal(slug);
      } catch (err) {
        log.error("dags.onSessionTerminal error", { slug, err: String(err) });
      }

      if (finalStatus === "completed") {
        try {
          await ctx.ship.onTurnCompleted(slug);
        } catch (err) {
          log.error("ship.onTurnCompleted error", { slug, err: String(err) });
        }
      }

      if (finalStatus === "completed") {
        await this.continueWithQueuedReplies(slug, providerName).catch((err) => {
          log.error("continueWithQueuedReplies failed", { slug, err: String(err) });
          return false;
        });
      }
    }).catch((err) => {
      log.error("handle waitForExit error", { slug, err: String(err) });
    });
  }

  markWaitingInput(slug: string, reason?: string): void {
    const row = this.getSessionRow(slug);
    if (!row) {
      throw new EngineError("not_found", `Session ${slug} not found`);
    }
    const now = nowIso();
    this.updateSessionStatus.run("waiting_input", now, null, slug);
    if (reason) {
      this.deps.log.debug("session marked waiting_input", { slug, reason });
    }
    const updatedRow = this.getSessionRow(slug)!;
    this.emitUpdated(this.buildSession(updatedRow));
  }

  appendAttention(slug: string, flag: AttentionFlag): void {
    const session = this.get(slug);
    if (!session) {
      throw new EngineError("not_found", `Session ${slug} not found`);
    }
    const next = [...session.attention, flag];
    this.repo.setAttention(slug, next);
    const updatedRow = this.getSessionRow(slug)!;
    this.emitUpdated(this.buildSession(updatedRow));
  }

  dismissAttention(slug: string, kind: AttentionFlag["kind"]): Session {
    const session = this.get(slug);
    if (!session) {
      throw new EngineError("not_found", `Session ${slug} not found`);
    }
    const remaining = session.attention.filter((a) => a.kind !== kind);
    if (remaining.length === session.attention.length) {
      return session;
    }
    this.repo.setAttention(slug, remaining);
    const updated = this.buildSession(this.getSessionRow(slug)!);
    this.emitUpdated(updated);
    return updated;
  }

  private hasBudgetExceeded(slug: string): boolean {
    const session = this.get(slug);
    if (!session) return false;
    return session.attention.some((a) => a.kind === "budget_exceeded");
  }

  async kickReplyQueue(slug: string): Promise<boolean> {
    if (this.handles.has(slug)) return false;
    const row = this.getSessionRow(slug);
    if (!row) return false;
    if (this.hasBudgetExceeded(slug)) return false;
    return this.continueWithQueuedReplies(slug, row.provider);
  }

  private async continueWithQueuedReplies(slug: string, providerName: string): Promise<boolean> {
    if (this.hasBudgetExceeded(slug)) return false;

    const claim = this.replyQueue.claim(slug);
    if (!claim) return false;

    const row = this.getSessionRow(slug);
    if (!row || !row.worktree_path) {
      this.replyQueue.release(claim.claimToken);
      return false;
    }

    const additionalPrompt = claim.entries.map((p) => p.payload).join("\n\n");
    const providerState = this.getProviderState.get(slug) as ProviderStateRow | undefined;

    const provider = getProvider(providerName);
    const homeDir = this.paths.home(providerName);

    const env: Record<string, string> = {
      HOME: homeDir,
      MINIONS_SESSION_SLUG: slug,
      MINIONS_SLUG: slug,
      MINIONS_WORKTREE: row.worktree_path,
      MINIONS_UPLOADS_DIR: this.paths.uploads(slug),
      MINIONS_CLAUDE_HOME: homeDir,
    };
    if (process.env["ANTHROPIC_API_KEY"]) {
      env["ANTHROPIC_API_KEY"] = process.env["ANTHROPIC_API_KEY"];
    }

    const permissionTier = derivePermissionTier(
      row.mode as SessionMode,
      row.ship_stage as import("@minions/shared").ShipStage | null,
    );

    const mcpConfigPath = await this.writeMcpConfig(slug, row.worktree_path);

    let handle: ProviderHandle;
    try {
      handle = await provider.resume({
        sessionSlug: slug,
        worktree: row.worktree_path,
        externalId: providerState?.external_id ?? undefined,
        env,
        mcpConfigPath,
        additionalPrompt,
        permissionTier,
      });
    } catch (err) {
      const errString = String(err);
      const isStaleMarker = /No deferred tool marker found/i.test(errString);
      // Mid-deploy stale-marker recovery: the Claude deferred-tool runtime
      // can't find its marker file (rotated by the engine restart), but the
      // upstream conversation still exists. Spawn a fresh process with
      // `--resume <externalId>` so Claude rehydrates context but bypasses
      // the marker check, and ride the queued reply in via additionalPrompt.
      if (isStaleMarker && providerState?.external_id) {
        this.deps.log.warn(
          "resume hit stale deferred-tool marker; falling back to spawn --resume",
          { slug, err: errString },
        );
        try {
          const preamble = this.deps.ctx.memory.renderPreamble(row.repo_id ?? undefined);
          handle = await provider.spawn({
            sessionSlug: slug,
            worktree: row.worktree_path,
            prompt: row.prompt,
            modelHint: row.model_hint ?? undefined,
            env,
            preamble,
            mcpConfigPath,
            additionalPrompt,
            permissionTier,
            externalId: providerState.external_id,
          });
        } catch (spawnErr) {
          this.replyQueue.release(claim.claimToken);
          throw spawnErr;
        }
        this.deps.ctx.audit.record(
          "system",
          "session.retry.spawn-fallback",
          { kind: "session", id: slug },
          { provider: providerName, externalId: providerState.external_id },
        );
        // Clear the stale-marker attention flag so the recovery footer
        // reflects the new run rather than the prior failure.
        const session = this.buildSession(row);
        const remaining = session.attention.filter(
          (a) => !(a.kind === "manual_intervention" && /stale marker/i.test(a.message)),
        );
        if (remaining.length !== session.attention.length) {
          this.repo.setAttention(slug, remaining);
        }
      } else {
        this.replyQueue.release(claim.claimToken);
        throw err;
      }
    }

    this.replyQueue.confirm(claim.claimToken);

    this.handles.set(slug, handle);

    if (handle.externalId) {
      this.upsertProviderState.run(slug, providerName, handle.externalId, 0, 0, "{}", nowIso());
    }

    this.deps.ctx.audit.record(
      "system",
      "session.reply.delivered",
      { kind: "session", id: slug },
      { count: claim.entries.length, provider: providerName },
    );

    this.updateSession.run("running", nowIso(), nowIso(), null, row.worktree_path, row.branch ?? null, slug);
    const updatedRow = this.getSessionRow(slug)!;
    this.emitUpdated(this.buildSession(updatedRow));

    this.pipeHandle(slug, handle, providerName, updatedRow.stats_turns);
    return true;
  }

  async resumeAllActive(): Promise<void> {
    const { log, ctx } = this.deps;

    const recovered = this.replyQueue.recoverInFlight(30_000);
    if (recovered > 0) {
      log.info("released stale reply queue claims at boot", { recovered });
    }

    const rows = this.listActiveSession.all() as SessionRow[];

    for (const row of rows) {
      const slug = row.slug;
      if (this.handles.has(slug)) continue;

      const worktreePath = row.worktree_path;
      if (!worktreePath) {
        log.warn("cannot resume session without worktree_path", { slug });
        ctx.audit.record("system", "session.resume.skipped", { kind: "session", id: slug }, {
          reason: "missing-worktree-path",
        });
        this.updateSessionStatus.run("failed", nowIso(), nowIso(), slug);
        const updatedRow = this.getSessionRow(slug)!;
        this.emitUpdated(this.buildSession(updatedRow));
        continue;
      }

      const providerState = this.getProviderState.get(slug) as ProviderStateRow | undefined;
      const providerName = row.provider;

      try {
        const provider = getProvider(providerName);
        const homeDir = this.paths.home(providerName);

        const env: Record<string, string> = {
          HOME: homeDir,
          MINIONS_SESSION_SLUG: slug,
          MINIONS_SLUG: slug,
          MINIONS_WORKTREE: worktreePath,
          MINIONS_UPLOADS_DIR: this.paths.uploads(slug),
          MINIONS_CLAUDE_HOME: homeDir,
        };
        if (process.env["ANTHROPIC_API_KEY"]) {
          env["ANTHROPIC_API_KEY"] = process.env["ANTHROPIC_API_KEY"];
        }
        const ghToken = await tryGetGithubToken(this.deps.ctx);
        if (ghToken) {
          env["GH_TOKEN"] = ghToken;
          env["GITHUB_TOKEN"] = ghToken;
        }

        const mcpConfigPath = worktreePath
          ? await this.writeMcpConfig(slug, worktreePath)
          : undefined;

        const permissionTier = derivePermissionTier(
          row.mode as SessionMode,
          row.ship_stage as import("@minions/shared").ShipStage | null,
        );

        const handle = await provider.resume({
          sessionSlug: slug,
          worktree: worktreePath,
          externalId: providerState?.external_id ?? undefined,
          env,
          mcpConfigPath,
          permissionTier,
        });

        this.handles.set(slug, handle);

        if (handle.externalId) {
          this.upsertProviderState.run(slug, providerName, handle.externalId, 0, 0, "{}", nowIso());
        }

        this.pipeHandle(slug, handle, providerName, providerState?.last_turn ?? 0);

        ctx.audit.record("system", "session.resume", { kind: "session", id: slug }, {
          provider: providerName,
          externalId: handle.externalId ?? null,
        });
        log.info("resumed session", { slug });
      } catch (err) {
        const errString = String(err);
        if (/No deferred tool marker found/i.test(errString)) {
          log.warn("session resume skipped: stale deferred-tool marker after engine restart", {
            slug,
            err: errString,
          });
          this.failSessionWithAttention(
            slug,
            "resume failed: stale marker after engine restart; please retry or re-dispatch",
          );
          ctx.audit.record("system", "session.resume.failed", { kind: "session", id: slug }, {
            reason: "stale_marker",
            error: errString,
          });
          continue;
        }
        log.error("failed to resume session", { slug, err: errString });
        ctx.audit.record("system", "session.resume.failed", { kind: "session", id: slug }, {
          error: errString,
        });
        this.updateSessionStatus.run("failed", nowIso(), nowIso(), slug);
        const updatedRow = this.getSessionRow(slug)!;
        this.emitUpdated(this.buildSession(updatedRow));
      }
    }
  }

  async reply(slug: string, text: string, attachments?: import("@minions/shared").AttachmentInput[]): Promise<void> {
    const { db, ctx, workspaceDir } = this.deps;
    const row = this.getSessionRow(slug);
    if (!row) {
      throw new EngineError("not_found", `Session ${slug} not found`);
    }

    const copied: { name: string; mimeType: string; url?: string }[] = [];
    if (attachments && attachments.length > 0) {
      const sessionUploads = this.paths.uploads(slug);
      await ensureDir(sessionUploads);
      const globalUploads = path.join(workspaceDir, "uploads");
      for (const att of attachments) {
        const safeName = sanitizeAttachmentName(att.name);
        const safeMime = assertAllowedMime(att.mimeType);
        const dst = path.join(sessionUploads, safeName);

        if (att.url) {
          if (!att.url.startsWith("/api/uploads/")) {
            throw new EngineError("bad_request", "attachment url must start with /api/uploads/");
          }
          const filename = att.url.slice("/api/uploads/".length);
          if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
            throw new EngineError("bad_request", "attachment url has invalid filename");
          }
          await fs.copyFile(path.join(globalUploads, filename), dst);
          copied.push({ name: safeName, mimeType: safeMime, url: att.url });
        } else if (att.dataBase64) {
          const buf = Buffer.from(att.dataBase64, "base64");
          assertWithinSize(buf.byteLength);
          await fs.writeFile(dst, buf);
          copied.push({ name: safeName, mimeType: safeMime });
        } else {
          throw new EngineError("bad_request", "attachment must include url or dataBase64");
        }
      }
    }

    const now = nowIso();
    const seq = (db.prepare(
      `SELECT COALESCE(MAX(seq), -1) AS last_seq FROM transcript_events WHERE session_slug = ?`,
    ).get(slug) as { last_seq: number }).last_seq + 1;

    const body: Record<string, unknown> = { text, source: "operator" };
    if (copied.length > 0) body["attachments"] = copied;
    const bodyJson = JSON.stringify(body);

    const eventId = newEventId();
    db.prepare(
      `INSERT OR IGNORE INTO transcript_events(id, session_slug, seq, turn, kind, body, timestamp)
       VALUES (?, ?, ?, ?, 'user_message', ?, ?)`,
    ).run(
      eventId, slug, seq,
      (db.prepare(`SELECT stats_turns FROM sessions WHERE slug = ?`).get(slug) as { stats_turns: number } | undefined)?.stats_turns ?? 0,
      bodyJson,
      now,
    );

    const sessionRow = this.getSessionRow(slug)!;
    const children = (this.listChildren.all(slug) as Array<{ slug: string }>).map((r) => r.slug);
    const session = rowToSession(sessionRow, children);
    const transcriptEv = rowToTranscriptEvent({
      id: eventId, session_slug: slug, seq,
      turn: (session.stats.turns ?? 0),
      kind: "user_message",
      body: bodyJson,
      timestamp: now,
    });
    this.deps.bus.emit({ kind: "transcript_event", sessionSlug: slug, event: transcriptEv });

    const payload = copied.length > 0
      ? `${text}\n\n[Attached: ${copied.map((a) => a.name).join(", ")}]\n`
      : text;

    this.replyQueue.enqueue(slug, payload);
    ctx.audit.record("operator", "session.reply.queued", { kind: "session", id: slug });
  }

  setDagId(slug: string, dagId: string): void {
    const { db } = this.deps;
    const row = this.getSessionRow(slug);
    if (!row) {
      throw new EngineError("not_found", `Session ${slug} not found`);
    }
    db.prepare(`UPDATE sessions SET dag_id = ?, updated_at = ? WHERE slug = ?`).run(
      dagId,
      nowIso(),
      slug,
    );
    const updatedRow = this.getSessionRow(slug)!;
    this.emitUpdated(this.buildSession(updatedRow));
  }

  setMetadata(slug: string, patch: Record<string, unknown>): void {
    const row = this.getSessionRow(slug);
    if (!row) {
      throw new EngineError("not_found", `Session ${slug} not found`);
    }
    this.repo.setMetadata(slug, patch);
    const updatedRow = this.getSessionRow(slug)!;
    this.emitUpdated(this.buildSession(updatedRow));
  }

  markCompleted(slug: string): void {
    const row = this.getSessionRow(slug);
    if (!row) {
      throw new EngineError("not_found", `Session ${slug} not found`);
    }
    const now = nowIso();
    this.updateSessionStatus.run("completed", now, now, slug);
    const updatedRow = this.getSessionRow(slug)!;
    this.emitUpdated(this.buildSession(updatedRow));
  }

  markFailed(slug: string): void {
    const row = this.getSessionRow(slug);
    if (!row) {
      throw new EngineError("not_found", `Session ${slug} not found`);
    }
    const now = nowIso();
    this.updateSessionStatus.run("failed", now, now, slug);
    const updatedRow = this.getSessionRow(slug)!;
    this.emitUpdated(this.buildSession(updatedRow));
  }

  async stop(slug: string, _reason?: string): Promise<void> {
    const row = this.getSessionRow(slug);
    if (!row) {
      throw new EngineError("not_found", `Session ${slug} not found`);
    }

    const now = nowIso();
    this.updateSessionStatus.run("cancelled", now, now, slug);

    const handle = this.handles.get(slug);
    if (handle) {
      handle.kill("SIGINT");
      const timeout = setTimeout(() => {
        handle.kill("SIGKILL");
      }, 5000);

      handle.waitForExit().then(() => clearTimeout(timeout)).catch(() => clearTimeout(timeout));
    }

    const updatedRow = this.getSessionRow(slug)!;
    this.emitUpdated(this.buildSession(updatedRow));
  }

  async close(slug: string, removeWorktreeFlag?: boolean): Promise<void> {
    const { log, workspaceDir } = this.deps;
    const row = this.getSessionRow(slug);
    if (!row) {
      throw new EngineError("not_found", `Session ${slug} not found`);
    }

    const status = row.status as SessionStatus;
    if (status === "running" || status === "waiting_input") {
      await this.stop(slug);
    }

    if (removeWorktreeFlag && row.repo_id && row.worktree_path) {
      try {
        await removeWorktree(this.paths.repos, workspaceDir, row.repo_id, slug, log);
      } catch (err) {
        log.warn("removeWorktree failed", { slug, err: String(err) });
      }
    }
  }

  async delete(slug: string): Promise<void> {
    // Serialize per-slug against setupAndSpawn so we cannot drop the parent row
    // while a concurrent spawn is mid-flight and about to insert FK-bearing
    // child rows (provider_state, transcript_events).
    return this.slugMutex.run(slug, async () => {
      const { db, bus, log, workspaceDir } = this.deps;
      const row = this.getSessionRow(slug);
      if (!row) {
        throw new EngineError("not_found", `Session ${slug} not found`);
      }

      const handle = this.handles.get(slug);
      if (handle) {
        handle.kill("SIGKILL");
        this.handles.delete(slug);
      }

      const tx = db.transaction((s: string) => {
        db.prepare(`DELETE FROM transcript_events WHERE session_slug = ?`).run(s);
        db.prepare(`DELETE FROM reply_queue WHERE session_slug = ?`).run(s);
        db.prepare(`DELETE FROM screenshots WHERE session_slug = ?`).run(s);
        db.prepare(`DELETE FROM checkpoints WHERE session_slug = ?`).run(s);
        db.prepare(`DELETE FROM provider_state WHERE session_slug = ?`).run(s);
        db.prepare(`DELETE FROM sessions WHERE slug = ?`).run(s);
      });
      tx(slug);

      if (row.repo_id && row.worktree_path) {
        try {
          await removeWorktree(this.paths.repos, workspaceDir, row.repo_id, slug, log);
        } catch (err) {
          log.warn("delete: removeWorktree failed", { slug, err: String(err) });
        }
      }

      const sideTargets = [
        path.join(workspaceDir, "uploads", slug),
        path.join(workspaceDir, "reply-queue", `${slug}.jsonl`),
        path.join(workspaceDir, "mcp-configs", `${slug}.json`),
      ];
      for (const target of sideTargets) {
        try {
          await fs.rm(target, { recursive: true, force: true });
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code !== "ENOENT") {
            log.warn("delete: side-effect rm failed", { slug, target, err: String(err) });
          }
        }
      }

      this.deps.ctx.audit.record(
        "operator",
        "session.delete",
        { kind: "session", id: slug },
        {},
      );

      bus.emit({ kind: "session_deleted", slug });
    });
  }

  async diff(slug: string): Promise<WorkspaceDiff> {
    const row = this.getSessionRow(slug);
    if (!row) {
      throw new EngineError("not_found", `Session ${slug} not found`);
    }
    return computeDiff(slug, {
      worktreePath: row.worktree_path ?? "",
      baseBranch: row.base_branch ?? undefined,
    });
  }

  screenshots_list(slug: string): Screenshot[] {
    return this.screenshots.list(slug);
  }

  screenshotPath(slug: string, filename: string): string {
    return this.screenshots.screenshotPath(slug, filename);
  }

  checkpoints(slug: string): Checkpoint[] {
    return this.checkpointStore.list(slug);
  }

  async restoreCheckpoint(slug: string, id: string): Promise<void> {
    const row = this.getSessionRow(slug);
    if (!row) {
      throw new EngineError("not_found", `Session ${slug} not found`);
    }
    await this.checkpointStore.restore(slug, id, {
      worktreePath: row.worktree_path ?? "",
      branch: row.branch ?? undefined,
    });
  }
}
