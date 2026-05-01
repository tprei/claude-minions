import type { AutomationJob } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";
import type { AutomationJobRepo } from "../store/repos/automationJobRepo.js";
import type { JobHandler } from "./types.js";

export interface AutomationRunnerDeps {
  repo: AutomationJobRepo;
  ctx: EngineContext;
  log: Logger;
  handlers: Map<string, JobHandler>;
  leaseOwner?: string;
  tickIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  now?: () => Date;
}

export interface AutomationRunner {
  start(): void;
  stop(): Promise<void>;
  tickOnce(): Promise<number>;
}

const MAX_PER_TICK = 4;
const LEASE_DURATION_MS = 120_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 5 * 60 * 1000;
const DEFAULT_TICK_SEC = 5;

function computeBackoff(attempts: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempts);
}

export function createAutomationRunner(deps: AutomationRunnerDeps): AutomationRunner {
  const { repo, ctx, log, handlers } = deps;
  const leaseOwner = deps.leaseOwner ?? "runner-1";
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const nowDate = deps.now ?? (() => new Date());

  let timer: ReturnType<typeof setInterval> | null = null;
  let booted = false;
  let inflight: Promise<void> | null = null;

  async function processOne(job: AutomationJob): Promise<void> {
    const handler = handlers.get(job.kind);
    if (!handler) {
      const message = `unknown handler: ${job.kind}`;
      log.warn("automation runner: unknown handler", { jobId: job.id, kind: job.kind });
      repo.fail(job.id, message, computeBackoff(job.attempts));
      return;
    }
    try {
      await handler(job, ctx);
      repo.succeed(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("automation runner: job failed", {
        jobId: job.id,
        kind: job.kind,
        attempts: job.attempts,
        error: message,
      });
      repo.fail(job.id, message, computeBackoff(job.attempts));
    }
  }

  async function tickOnce(): Promise<number> {
    let claimed = 0;
    for (let i = 0; i < MAX_PER_TICK; i++) {
      const job = repo.claimNextDue(nowDate().toISOString(), leaseOwner, LEASE_DURATION_MS);
      if (!job) break;
      claimed++;
      await processOne(job);
    }
    return claimed;
  }

  function bootRecovery(): void {
    if (booted) return;
    booted = true;
    try {
      const released = repo.releaseExpiredLeases(nowDate().toISOString());
      if (released > 0) {
        log.info("automation runner: released expired leases on boot", { count: released });
      }
    } catch (err) {
      log.error("automation runner: boot recovery failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function readTickMs(): number {
    if (typeof deps.tickIntervalMs === "number") return deps.tickIntervalMs;
    const cfg = ctx.runtime.effective();
    const sec = (cfg["automationTickSec"] as number | undefined) ?? DEFAULT_TICK_SEC;
    return Math.max(1, sec) * 1000;
  }

  function scheduleTick(): void {
    if (inflight !== null) return;
    inflight = tickOnce()
      .then(() => {})
      .catch((err) => {
        log.error("automation runner: tick error", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inflight = null;
      });
  }

  function start(): void {
    if (timer !== null) return;
    bootRecovery();
    const intervalMs = readTickMs();
    timer = setIntervalFn(scheduleTick, intervalMs);
    if (timer && typeof (timer as NodeJS.Timeout).unref === "function") {
      (timer as NodeJS.Timeout).unref();
    }
  }

  async function stop(): Promise<void> {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
    if (inflight !== null) {
      await inflight;
    }
  }

  return { start, stop, tickOnce };
}
