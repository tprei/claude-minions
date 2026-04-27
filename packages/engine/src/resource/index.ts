import type { ResourceSnapshot } from "@minions/shared";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { ResourceMonitor } from "./monitor.js";

export interface ResourceSubsystem {
  latest: () => ResourceSnapshot | null;
  start: () => void;
  stop: () => void;
}

export function createResourceSubsystem(deps: SubsystemDeps): SubsystemResult<ResourceSubsystem> {
  const monitor = new ResourceMonitor(deps.db, deps.workspaceDir);
  let cached: ResourceSnapshot | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function tick(): Promise<void> {
    try {
      const snapshot = await monitor.sample();
      cached = snapshot;
      deps.bus.emit({ kind: "resource", snapshot });
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
  };

  return {
    api,
    onShutdown() {
      api.stop();
    },
  };
}
