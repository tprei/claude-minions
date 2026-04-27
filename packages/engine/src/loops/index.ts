import type { LoopDefinition } from "@minions/shared";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { newId } from "../util/ids.js";
import { applyJitterPct } from "../util/jitter.js";
import { EngineError } from "../errors.js";
import { shouldRun, computeNextRun } from "./scheduler.js";
import { registerLoopsRoutes } from "./routes.js";

const LOOP_MAX_TOTAL_DEFAULT = 20;

interface LoopRow {
  id: string;
  label: string;
  prompt: string;
  interval_sec: number;
  enabled: number;
  model_hint: string | null;
  repo_id: string | null;
  base_branch: string | null;
  jitter_pct: number;
  max_concurrent: number;
  consecutive_failures: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_session_slug: string | null;
  created_at: string;
  updated_at: string;
}

function rowToLoop(r: LoopRow): LoopDefinition {
  return {
    id: r.id,
    label: r.label,
    prompt: r.prompt,
    intervalSec: r.interval_sec,
    enabled: r.enabled === 1,
    modelHint: r.model_hint ?? undefined,
    repoId: r.repo_id ?? undefined,
    baseBranch: r.base_branch ?? undefined,
    jitterPct: r.jitter_pct,
    maxConcurrent: r.max_concurrent,
    consecutiveFailures: r.consecutive_failures,
    nextRunAt: r.next_run_at ?? undefined,
    lastRunAt: r.last_run_at ?? undefined,
    lastSessionSlug: r.last_session_slug ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface LoopsSubsystem {
  list: () => LoopDefinition[];
  upsert: (def: Omit<LoopDefinition, "id" | "createdAt" | "updatedAt" | "consecutiveFailures">) => LoopDefinition;
  setEnabled: (id: string, enabled: boolean) => void;
  delete: (id: string) => void;
  tick: () => Promise<void>;
}

export function createLoopsSubsystem(
  deps: SubsystemDeps,
): SubsystemResult<LoopsSubsystem> {
  const { db, log, env, ctx } = deps;

  const stmtList = db.prepare<[], LoopRow>("SELECT * FROM loops ORDER BY created_at ASC");
  const stmtById = db.prepare<[string], LoopRow>("SELECT * FROM loops WHERE id = ?");
  const stmtInsert = db.prepare<
    [string, string, string, number, number, string | null, string | null, string | null, number, number, string | null, string, string],
    void
  >(`
    INSERT INTO loops (id, label, prompt, interval_sec, enabled, model_hint, repo_id, base_branch, jitter_pct, max_concurrent, next_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtUpdate = db.prepare<
    [string, string, number, number, string | null, string | null, string | null, number, number, string | null, string, string],
    void
  >(`
    UPDATE loops SET label=?, prompt=?, interval_sec=?, enabled=?, model_hint=?, repo_id=?, base_branch=?, jitter_pct=?, max_concurrent=?, next_run_at=?, updated_at=?
    WHERE id=?
  `);
  const stmtSetEnabled = db.prepare<[number, string, string], void>(
    "UPDATE loops SET enabled=?, updated_at=? WHERE id=?",
  );
  const stmtDelete = db.prepare<[string], void>("DELETE FROM loops WHERE id=?");
  const stmtSetNextRun = db.prepare<[string, string, string, number, string, string], void>(
    "UPDATE loops SET next_run_at=?, last_run_at=?, last_session_slug=?, consecutive_failures=?, updated_at=? WHERE id=?",
  );
  const stmtIncrFailures = db.prepare<[number, string, string, string], void>(
    "UPDATE loops SET consecutive_failures=?, next_run_at=?, updated_at=? WHERE id=?",
  );

  let tickHandle: ReturnType<typeof setInterval> | null = null;

  function list(): LoopDefinition[] {
    return stmtList.all().map(rowToLoop);
  }

  function upsert(
    def: Omit<LoopDefinition, "id" | "createdAt" | "updatedAt" | "consecutiveFailures"> & { id?: string },
  ): LoopDefinition {
    const now = new Date().toISOString();
    if (def.id) {
      const existing = stmtById.get(def.id);
      if (!existing) throw new EngineError("not_found", `Loop ${def.id} not found`);
      stmtUpdate.run(
        def.label,
        def.prompt,
        def.intervalSec,
        def.enabled ? 1 : 0,
        def.modelHint ?? null,
        def.repoId ?? null,
        def.baseBranch ?? null,
        def.jitterPct ?? 0.1,
        def.maxConcurrent ?? 1,
        def.nextRunAt ?? null,
        now,
        def.id,
      );
      const updated = stmtById.get(def.id);
      if (!updated) throw new EngineError("internal", "Loop update failed");
      return rowToLoop(updated);
    }
    const id = newId();
    stmtInsert.run(
      id,
      def.label,
      def.prompt,
      def.intervalSec,
      def.enabled ? 1 : 0,
      def.modelHint ?? null,
      def.repoId ?? null,
      def.baseBranch ?? null,
      def.jitterPct ?? 0.1,
      def.maxConcurrent ?? 1,
      def.nextRunAt ?? null,
      now,
      now,
    );
    const inserted = stmtById.get(id);
    if (!inserted) throw new EngineError("internal", "Loop insert failed");
    return rowToLoop(inserted);
  }

  function setEnabled(id: string, enabled: boolean): void {
    const now = new Date().toISOString();
    stmtSetEnabled.run(enabled ? 1 : 0, now, id);
  }

  function del(id: string): void {
    stmtDelete.run(id);
  }

  async function tick(): Promise<void> {
    const now = Date.now();
    const loops = list();

    const runningSessions = ctx.sessions.list().filter(
      (s) => s.status === "running" || s.status === "pending" || s.status === "waiting_input",
    );

    const loopRunning = runningSessions.filter((s) => s.mode === "loop");

    const runtimeValues = ctx.runtime.effective();
    const loopMaxTotal = typeof runtimeValues["loopMaxTotal"] === "number"
      ? runtimeValues["loopMaxTotal"]
      : LOOP_MAX_TOTAL_DEFAULT;
    const reservedInteractive = typeof runtimeValues["loopReservedInteractive"] === "number"
      ? runtimeValues["loopReservedInteractive"]
      : env.loopReservedInteractive;

    const globalLoopCap = loopMaxTotal - reservedInteractive;
    const globalSlotsLeft = Math.max(0, globalLoopCap - loopRunning.length);

    if (globalSlotsLeft === 0) return;

    let usedGlobalSlots = 0;

    for (const loop of loops) {
      if (usedGlobalSlots >= globalSlotsLeft) break;

      const runningForThisLoop = loopRunning.filter(
        (s) => s.metadata["loopId"] === loop.id || s.loopId === loop.id,
      ).length;
      const maxConcurrent = loop.maxConcurrent ?? 1;
      const perLoopSlots = maxConcurrent - runningForThisLoop;

      if (!shouldRun(loop, now, perLoopSlots > 0)) continue;

      try {
        const session = await ctx.sessions.create({
          mode: "loop",
          prompt: loop.prompt,
          repoId: loop.repoId,
          baseBranch: loop.baseBranch,
          modelHint: loop.modelHint,
          metadata: { loopId: loop.id },
        });

        const jitterPct = loop.jitterPct ?? 0.1;
        const baseIntervalMs = loop.intervalSec * 1000;
        const intervalMs = applyJitterPct(baseIntervalMs, jitterPct);
        const nextRunAt = new Date(now + intervalMs).toISOString();

        stmtSetNextRun.run(nextRunAt, new Date(now).toISOString(), session.slug, 0, new Date().toISOString(), loop.id);
        usedGlobalSlots++;

        log.info("loop session spawned", { loopId: loop.id, sessionSlug: session.slug, nextRunAt });

        const unsubscribe = ctx.bus.on("session_updated", function onSessionDone(evt) {
          if (evt.session.slug !== session.slug) return;
          const status = evt.session.status;
          if (status !== "completed" && status !== "failed" && status !== "cancelled") return;
          unsubscribe();

          if (status === "failed") {
            const currentLoop = list().find((l) => l.id === loop.id);
            if (!currentLoop) return;
            const failures = currentLoop.consecutiveFailures + 1;
            const nextRun = computeNextRun({ ...currentLoop, consecutiveFailures: failures }, Date.now());
            stmtIncrFailures.run(failures, nextRun, new Date().toISOString(), loop.id);
            log.warn("loop session failed, backing off", { loopId: loop.id, failures, nextRun });
          }
        });
      } catch (err) {
        log.error("failed to spawn loop session", { loopId: loop.id, err: (err as Error).message });
        const currentLoop = list().find((l) => l.id === loop.id);
        if (currentLoop) {
          const failures = currentLoop.consecutiveFailures + 1;
          const nextRun = computeNextRun({ ...currentLoop, consecutiveFailures: failures }, Date.now());
          stmtIncrFailures.run(failures, nextRun, new Date().toISOString(), loop.id);
        }
      }
    }
  }

  function startScheduler(): void {
    if (tickHandle !== null) {
      log.warn("loops scheduler already started; skipping");
      return;
    }
    const intervalMs = (env.loopTickSec ?? 5) * 1000;
    tickHandle = setInterval(() => {
      tick().catch((err) => log.error("loop tick error", { err: (err as Error).message }));
    }, intervalMs);
    log.info("loops scheduler started", { intervalMs });
  }

  startScheduler();

  function onShutdown(): void {
    if (tickHandle) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  }

  const api: LoopsSubsystem = {
    list,
    upsert: upsert as LoopsSubsystem["upsert"],
    setEnabled,
    delete: del,
    tick,
  };

  return {
    api,
    registerRoutes(app) {
      registerLoopsRoutes(app, ctx);
    },
    onShutdown,
  };
}
