import type { CleanupExecuteError, Session } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";

export interface CleanupCronDeps {
  cleanup: EngineContext["cleanup"];
  sessions: EngineContext["sessions"];
  dags: EngineContext["dags"];
  runtime: EngineContext["runtime"];
  audit: EngineContext["audit"];
  log: Logger;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  setIntervalFn?: typeof setInterval;
}

export interface TickSummary {
  checked: number;
  deleted: number;
  bytesReclaimed: number;
  errors: CleanupExecuteError[];
  skipped?: "warmup" | "disabled";
}

export interface CleanupCron {
  start(): void;
  stop(): Promise<void>;
  tickForTest(): Promise<TickSummary>;
}

const WARMUP_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OLDER_THAN_DAYS = 7;
const DEFAULT_HOUR_LOCAL = 3;
const SELECT_LIMIT = 100;

export function msUntilNextLocalHour(hour: number, nowMs: number): number {
  const d = new Date(nowMs);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0);
  if (next.getTime() <= nowMs) next.setDate(next.getDate() + 1);
  return next.getTime() - nowMs;
}

export function makeCleanupCron(deps: CleanupCronDeps): CleanupCron {
  const { cleanup, sessions, dags, runtime, audit, log } = deps;
  const now = deps.now ?? (() => Date.now());
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;

  let startedAt = 0;
  let initialTimerHandle: ReturnType<typeof setTimeout> | null = null;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let inflightTick: Promise<void> | null = null;

  async function tick(): Promise<TickSummary> {
    if (now() - startedAt < WARMUP_MS) {
      log.info("cleanup cron skipped (warmup)");
      return { checked: 0, deleted: 0, bytesReclaimed: 0, errors: [], skipped: "warmup" };
    }

    const cfg = runtime.effective();
    if (cfg.autoCleanupEnabled !== true) {
      return { checked: 0, deleted: 0, bytesReclaimed: 0, errors: [], skipped: "disabled" };
    }

    const olderThanDays = Number(cfg.cleanupOlderThanDays ?? DEFAULT_OLDER_THAN_DAYS);
    const { items } = await cleanup.selectCandidates({
      statuses: ["completed", "failed", "cancelled"],
      olderThanDays,
      limit: SELECT_LIMIT,
    });
    const checked = items.length;

    const resolved: Session[] = items
      .map((c) => sessions.get(c.slug))
      .filter((s): s is Session => s !== null);

    const dagIds = Array.from(
      new Set(
        resolved
          .map((s) => s.dagId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    );
    const activeDagIds = new Set<string>();
    for (const id of dagIds) {
      const dag = dags.get(id);
      if (dag?.status === "active") activeDagIds.add(id);
    }

    const survivors = resolved.filter((s) => {
      if (s.pr?.state === "open") return false;
      if (s.dagId && activeDagIds.has(s.dagId)) return false;
      return true;
    });

    let result: { deleted: number; bytesReclaimed: number; errors: CleanupExecuteError[] };
    try {
      result = await cleanup.execute({
        slugs: survivors.map((s) => s.slug),
        removeWorktree: true,
      });
    } catch (err) {
      result = {
        deleted: 0,
        bytesReclaimed: 0,
        errors: [{ slug: "*", code: "internal", message: String(err) }],
      };
    }

    audit.record("system", "cleanup.cron.tick", undefined, {
      checked,
      deleted: result.deleted,
      bytesReclaimed: result.bytesReclaimed,
      errors: result.errors,
    });

    return {
      checked,
      deleted: result.deleted,
      bytesReclaimed: result.bytesReclaimed,
      errors: result.errors,
    };
  }

  function runTick(): void {
    if (inflightTick !== null) return;
    const p = tick()
      .then(() => {})
      .catch((err) => {
        log.error("cleanup cron tick failed", { err: String(err) });
      })
      .finally(() => {
        inflightTick = null;
      });
    inflightTick = p;
  }

  function start(): void {
    startedAt = now();
    const cfg = runtime.effective();
    const hour = Number(cfg.cleanupHourLocal ?? DEFAULT_HOUR_LOCAL);
    const ms = msUntilNextLocalHour(hour, now());

    initialTimerHandle = setTimeoutFn(() => {
      initialTimerHandle = null;
      try {
        runTick();
      } catch (err) {
        log.error("cleanup cron initial timer failed", { err: String(err) });
      }
      intervalHandle = setIntervalFn(() => {
        try {
          runTick();
        } catch (err) {
          log.error("cleanup cron interval timer failed", { err: String(err) });
        }
      }, ONE_DAY_MS);
      if (intervalHandle && typeof intervalHandle.unref === "function") {
        intervalHandle.unref();
      }
    }, ms);
    if (initialTimerHandle && typeof initialTimerHandle.unref === "function") {
      initialTimerHandle.unref();
    }
  }

  async function stop(): Promise<void> {
    if (initialTimerHandle !== null) {
      clearTimeout(initialTimerHandle);
      initialTimerHandle = null;
    }
    if (intervalHandle !== null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    if (inflightTick !== null) {
      await inflightTick;
    }
  }

  async function tickForTest(): Promise<TickSummary> {
    return tick();
  }

  return { start, stop, tickForTest };
}
