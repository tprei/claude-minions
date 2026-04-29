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
import { Screenshots, type ScreenshotSource } from "./screenshots.js";
import { Checkpoints } from "./checkpoints.js";
import { computeDiff } from "./diff.js";
import { rowToSession, rowToTranscriptEvent, type SessionRow, type TranscriptRow } from "./mapper.js";
import { SessionRepo, type ListSessionsOptions, type ListSessionsResult } from "../store/repos/sessionRepo.js";
import { workspacePaths } from "../workspace/paths.js";
import { ensureBareClone } from "../workspace/cloner.js";
import { addWorktree, removeWorktree, initScratchRepo } from "../workspace/worktree.js";
import { linkDeps } from "../workspace/depsCache.js";
import { injectAssets } from "../workspace/assetInjector.js";
import {
  checkAdmission,
  classifyMode,
  emptyRunningByClass,
  type RunningByClass,
} from "./admission.js";

interface RepoRow {
  id: string;
  label: string;
  remote: string | null;
  default_branch: string;
}

function deriveAllowWriteTools(
  mode: SessionMode,
  shipStage: import("@minions/shared").ShipStage | null,
): boolean | undefined {
  if (mode === "ship") {
    const stage = shipStage ?? "think";
    return !READ_ONLY_STAGES.has(stage);
  }
  if (mode === "think") {
    return false;
  }
  return undefined;
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
}

const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const TRANSPARENT_PNG_1X1: Buffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

interface PrevSessionState {
  status: SessionStatus;
  attentionKinds: Set<string>;
}

export class SessionRegistry {
  private handles = new Map<string, ProviderHandle>();
  private readonly collector: TranscriptCollector;
  private readonly replyQueue: ReplyQueue;
  private readonly screenshots: Screenshots;
  private readonly checkpointStore: Checkpoints;
  private readonly paths: ReturnType<typeof workspacePaths>;
  private readonly repo: SessionRepo;
  private readonly prevSessionState = new Map<string, PrevSessionState>();

  private readonly insertSession: Database.Statement;
  private readonly updateSession: Database.Statement;
  private readonly getSession: Database.Statement;
  private readonly listSessions: Database.Statement;
  private readonly listChildren: Database.Statement;
  private readonly listActiveSession: Database.Statement;
  private readonly listAdmittedSession: Database.Statement;
  private readonly getProviderState: Database.Statement;
  private readonly upsertProviderState: Database.Statement;
  private readonly listTranscript: Database.Statement;
  private readonly listTranscriptSince: Database.Statement;
  private readonly updateSessionStatus: Database.Statement;
  private readonly getRepo: Database.Statement;

  constructor(private readonly deps: RegistryDeps) {
    const { db, bus, log, workspaceDir } = deps;

    this.paths = workspacePaths(workspaceDir);

    this.repo = new SessionRepo(db);
    this.collector = new TranscriptCollector({ db, bus, log });
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
        last_turn_at, dag_id, dag_node_id, loop_id, variant_of, metadata
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
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
      `SELECT mode FROM sessions WHERE status IN ('pending', 'running', 'waiting_input')`,
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

    bus.on("session_updated", (ev) => this.onSessionUpdated(ev.session));
  }

  private onSessionUpdated(session: Session): void {
    const slug = session.slug;
    const newStatus = session.status;
    const newKinds = new Set(session.attention.map((a) => a.kind));
    const prev = this.prevSessionState.get(slug);
    this.prevSessionState.set(slug, { status: newStatus, attentionKinds: newKinds });

    const wasTerminal = prev ? TERMINAL_STATUSES.has(prev.status) : false;
    const isTerminal = TERMINAL_STATUSES.has(newStatus);

    if (isTerminal && !wasTerminal) {
      const source: ScreenshotSource = newStatus === "failed" ? "failure" : "turn_end";
      this.captureLifecycle(slug, source);
      return;
    }

    const prevKinds = prev?.attentionKinds ?? new Set<string>();
    for (const kind of newKinds) {
      if (!prevKinds.has(kind)) {
        this.captureLifecycle(slug, "readiness_change");
        return;
      }
    }
  }

  private captureLifecycle(slug: string, source: ScreenshotSource): void {
    this.screenshots
      .capture(slug, { source, pngBuffer: TRANSPARENT_PNG_1X1 })
      .catch((err) => {
        this.deps.log.warn("screenshot capture failed", { slug, source, err: String(err) });
      });
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

  private countRunningByClass(): RunningByClass {
    const counts = emptyRunningByClass();
    const rows = this.listAdmittedSession.all() as Array<{ mode: string }>;
    for (const row of rows) {
      const cls = classifyMode(row.mode as SessionMode);
      counts[cls] += 1;
    }
    return counts;
  }

  async create(req: CreateSessionRequest): Promise<Session> {
    const { db, bus, log, ctx, workspaceDir } = this.deps;

    const slug = newSlug();
    const now = nowIso();
    const mode: SessionMode = req.mode ?? "task";

    const cls = classifyMode(mode);
    const runningByClass = this.countRunningByClass();
    const decision = checkAdmission(cls, runningByClass, ctx.runtime.effective());
    if (!decision.admit) {
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
      JSON.stringify(req.metadata ?? {}),
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

    ctx.audit.record("operator", "session.create", { kind: "session", id: slug });

    try {
      await this.setupAndSpawn(slug, req, session, providerName);
    } catch (err) {
      log.error("session setup failed", { slug, err: String(err) });
      this.updateSessionStatus.run("failed", nowIso(), nowIso(), slug);
      const updatedRow = this.getSessionRow(slug)!;
      this.emitUpdated(this.buildSession(updatedRow));
      throw err;
    }

    return this.buildSession(this.getSessionRow(slug)!);
  }

  private getRootSlug(parentSlug: string): string | null {
    const row = this.getSessionRow(parentSlug);
    if (!row) return null;
    return row.root_slug ?? parentSlug;
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

    let worktreePath: string;
    let branch: string | undefined;

    if (req.repoId) {
      const repoRow = this.getRepo.get(req.repoId) as RepoRow | undefined;
      if (!repoRow) {
        throw new EngineError("not_found", `Repo ${req.repoId} not found`);
      }

      if (repoRow.remote) {
        await ensureBareClone(req.repoId, repoRow.remote, paths.repos, log);
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

      await linkDeps(req.repoId, worktreePath, paths.depsCache(req.repoId), log);
    } else {
      worktreePath = paths.worktree(slug);
      await initScratchRepo(worktreePath, slug, log);
    }

    await ensureDir(path.join(worktreePath, ".minions"));
    await ensureDir(path.join(worktreePath, ".minions", "screenshots"));
    await ensureDir(paths.uploads(slug));

    await injectAssets(worktreePath);

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

    const homeDir = paths.home(providerName);
    await ensureDir(homeDir);

    const env: Record<string, string> = {
      MINIONS_SESSION_SLUG: slug,
      MINIONS_WORKTREE: worktreePath,
      MINIONS_UPLOADS_DIR: paths.uploads(slug),
      MINIONS_CLAUDE_HOME: homeDir,
    };
    if (process.env["ANTHROPIC_API_KEY"]) {
      env["ANTHROPIC_API_KEY"] = process.env["ANTHROPIC_API_KEY"];
    }

    const mcpConfigPath = await this.writeMcpConfig(slug, worktreePath);

    const mode: SessionMode = req.mode ?? "task";
    const initialShipStage: import("@minions/shared").ShipStage = "think";
    const allowWriteTools = deriveAllowWriteTools(mode, mode === "ship" ? initialShipStage : null);

    const handle = await provider.spawn({
      sessionSlug: slug,
      worktree: worktreePath,
      prompt: req.prompt,
      modelHint: req.modelHint,
      env,
      preamble,
      mcpConfigPath,
      allowWriteTools,
    });

    this.handles.set(slug, handle);

    if (handle.externalId) {
      this.upsertProviderState.run(slug, providerName, handle.externalId, 0, 0, "{}", nowIso());
    } else {
      this.upsertProviderState.run(slug, providerName, null, 0, 0, "{}", nowIso());
    }

    this.updateSession.run("running", nowIso(), nowIso(), null, worktreePath, branch ?? null, slug);
    const updatedRow = this.getSessionRow(slug)!;
    this.emitUpdated(this.buildSession(updatedRow));

    this.pipeHandle(slug, handle, providerName);
  }

  private pipeHandle(slug: string, handle: ProviderHandle, providerName: string): void {
    const { log, ctx } = this.deps;

    const onExternalId = (externalId: string) => {
      this.upsertProviderState.run(slug, providerName, externalId, 0, 0, "{}", nowIso());
    };

    this.collector.collect(slug, handle, onExternalId).catch((err) => {
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
        const continued = await this.continueWithQueuedReplies(slug, providerName).catch((err) => {
          log.error("continueWithQueuedReplies failed", { slug, err: String(err) });
          return false;
        });
        if (continued) return;
      }

      const now = nowIso();
      this.updateSessionStatus.run(finalStatus, now, now, slug);

      const updatedRow = this.getSessionRow(slug)!;
      this.emitUpdated(this.buildSession(updatedRow));
    }).catch((err) => {
      log.error("handle waitForExit error", { slug, err: String(err) });
    });
  }

  private async continueWithQueuedReplies(slug: string, providerName: string): Promise<boolean> {
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
      MINIONS_SESSION_SLUG: slug,
      MINIONS_WORKTREE: row.worktree_path,
      MINIONS_UPLOADS_DIR: this.paths.uploads(slug),
      MINIONS_CLAUDE_HOME: homeDir,
    };
    if (process.env["ANTHROPIC_API_KEY"]) {
      env["ANTHROPIC_API_KEY"] = process.env["ANTHROPIC_API_KEY"];
    }

    let handle: ProviderHandle;
    try {
      const mcpConfigPath = await this.writeMcpConfig(slug, row.worktree_path);

      handle = await provider.resume({
        sessionSlug: slug,
        worktree: row.worktree_path,
        externalId: providerState?.external_id ?? undefined,
        env,
        mcpConfigPath,
        additionalPrompt,
      });
    } catch (err) {
      this.replyQueue.release(claim.claimToken);
      throw err;
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

    this.pipeHandle(slug, handle, providerName);
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
          MINIONS_SESSION_SLUG: slug,
          MINIONS_WORKTREE: worktreePath,
          MINIONS_UPLOADS_DIR: this.paths.uploads(slug),
          MINIONS_CLAUDE_HOME: homeDir,
        };
        if (process.env["ANTHROPIC_API_KEY"]) {
          env["ANTHROPIC_API_KEY"] = process.env["ANTHROPIC_API_KEY"];
        }

        const mcpConfigPath = worktreePath
          ? await this.writeMcpConfig(slug, worktreePath)
          : undefined;

        const allowWriteTools = deriveAllowWriteTools(
          row.mode as SessionMode,
          row.ship_stage as import("@minions/shared").ShipStage | null,
        );

        const handle = await provider.resume({
          sessionSlug: slug,
          worktree: worktreePath,
          externalId: providerState?.external_id ?? undefined,
          env,
          mcpConfigPath,
          allowWriteTools,
        });

        this.handles.set(slug, handle);

        if (handle.externalId) {
          this.upsertProviderState.run(slug, providerName, handle.externalId, 0, 0, "{}", nowIso());
        }

        this.pipeHandle(slug, handle, providerName);

        ctx.audit.record("system", "session.resume", { kind: "session", id: slug }, {
          provider: providerName,
          externalId: handle.externalId ?? null,
        });
        log.info("resumed session", { slug });
      } catch (err) {
        log.error("failed to resume session", { slug, err: String(err) });
        ctx.audit.record("system", "session.resume.failed", { kind: "session", id: slug }, {
          error: String(err),
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

    const copied: { name: string; mimeType: string; url: string }[] = [];
    if (attachments && attachments.length > 0) {
      const sessionUploads = this.paths.uploads(slug);
      await ensureDir(sessionUploads);
      const globalUploads = path.join(workspaceDir, "uploads");
      for (const att of attachments) {
        if (!att.url || !att.url.startsWith("/api/uploads/")) {
          throw new EngineError("bad_request", "attachment url must start with /api/uploads/");
        }
        const filename = att.url.slice("/api/uploads/".length);
        if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
          throw new EngineError("bad_request", "attachment url has invalid filename");
        }
        await fs.copyFile(path.join(globalUploads, filename), path.join(sessionUploads, att.name));
        copied.push({ name: att.name, mimeType: att.mimeType, url: att.url });
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
    const { db, bus } = this.deps;
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

    this.prevSessionState.delete(slug);

    bus.emit({ kind: "session_deleted", slug });
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
