import type { ResourceSnapshot } from "@minions/shared";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { ResourceMonitor } from "./monitor.js";
import {
  decideResourceAlert,
  type LastFiredMap,
  type ResourceAlertDecision,
  type ResourceAlertThresholds,
  type ResourceKind,
} from "./decideAlert.js";

export interface ResourceSubsystem {
  latest: () => ResourceSnapshot | null;
  start: () => void;
  stop: () => void;
  tick: () => Promise<void>;
}

export interface ResourceSubsystemOptions {
  sample?: () => Promise<ResourceSnapshot>;
}

function readThresholds(deps: SubsystemDeps): ResourceAlertThresholds {
  const cfg = deps.ctx.runtime.effective();
  const memoryPct = (cfg["resourceMemoryAlertPct"] as number | undefined) ?? 90;
  const diskPct = (cfg["resourceDiskAlertPct"] as number | undefined) ?? 90;
  const cooldownMin =
    (cfg["resourceAlertCooldownMin"] as number | undefined) ?? 60;
  return {
    memoryPct,
    diskPct,
    cooldownMs: cooldownMin * 60 * 1000,
  };
}

export function createResourceSubsystem(
  deps: SubsystemDeps,
  opts: ResourceSubsystemOptions = {},
): SubsystemResult<ResourceSubsystem> {
  const monitor = new ResourceMonitor(deps.db, deps.workspaceDir);
  const sample = opts.sample ?? (() => monitor.sample());
  let cached: ResourceSnapshot | null = null;
  let timer: NodeJS.Timeout | null = null;
  const lastFired: LastFiredMap = { memory: 0, disk: 0 };

  async function handleAlert(
    kind: ResourceKind,
    decision: ResourceAlertDecision,
    snapshot: ResourceSnapshot,
    now: number,
  ): Promise<void> {
    lastFired[kind] = now;
    const ctx = deps.ctx;
    try {
      await ctx.lifecycle.record({
        eventType: "resource.alert",
        severity: "warn",
        message: `${kind} usage at ${decision.pct.toFixed(0)}% (threshold ${decision.threshold}%)`,
        detail: {
          resource: kind,
          pct: decision.pct,
          threshold: decision.threshold,
          snapshot: {
            memUsedBytes: snapshot.memory.usedBytes,
            memLimitBytes: snapshot.memory.limitBytes,
            workspaceUsedBytes: snapshot.disk.workspaceUsedBytes,
            totalBytes: snapshot.disk.totalBytes,
          },
        },
      });
    } catch (e) {
      deps.log.warn("resource alert lifecycle.record failed", {
        kind,
        error: (e as Error).message,
      });
    }

    const cfg = ctx.runtime.effective();
    if (cfg["pushNotifyOnResourceAlert"] !== false) {
      try {
        await ctx.push.notify(
          "engine",
          `${kind} usage at ${decision.pct.toFixed(0)}%`,
          `engine ${kind} crossed ${decision.threshold}% threshold`,
          { kind: "resource.alert", resource: kind, pct: decision.pct },
        );
      } catch (e) {
        deps.log.warn("resource alert push.notify failed", {
          kind,
          error: (e as Error).message,
        });
      }
    }
  }

  async function processSnapshot(snapshot: ResourceSnapshot): Promise<void> {
    const now = Date.now();
    const thresholds = readThresholds(deps);
    const decision = decideResourceAlert(snapshot, thresholds, lastFired, now);
    if (decision.memory) await handleAlert("memory", decision.memory, snapshot, now);
    if (decision.disk) await handleAlert("disk", decision.disk, snapshot, now);
  }

  async function tick(): Promise<void> {
    try {
      const snapshot = await sample();
      cached = snapshot;
      deps.bus.emit({ kind: "resource", snapshot });
      try {
        await processSnapshot(snapshot);
      } catch (e) {
        deps.log.warn("resource alert handling failed", { error: (e as Error).message });
      }
    } catch (e) {
      deps.log.warn("resource sample failed", { error: (e as Error).message });
    }
  }

  const api: ResourceSubsystem = {
    latest() {
      return cached;
    },

    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), deps.env.resourceSampleSec * 1000);
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    tick,
  };

  return {
    api,
    onShutdown() {
      api.stop();
    },
  };
}
