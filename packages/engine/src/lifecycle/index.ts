import type { LifecycleEvent, LifecycleEventType, LifecycleSeverity } from "@minions/shared";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { LifecycleRepo } from "../store/repos/lifecycleRepo.js";

export interface LifecycleEventInput {
  eventType: LifecycleEventType;
  severity: LifecycleSeverity;
  message: string;
  detail?: Record<string, unknown>;
}

export interface LifecycleListResult {
  items: LifecycleEvent[];
  nextCursor?: string;
}

export interface LifecycleSubsystem {
  record(input: LifecycleEventInput): Promise<void>;
  list(limit?: number, beforeTs?: string): LifecycleListResult;
}

const DEFAULT_LIMIT = 100;

const TITLES: Record<LifecycleEventType, string> = {
  "engine.started": "Engine started",
  "engine.crashed": "Engine crashed",
  "ci.exhausted": "CI exhausted",
  "resource.alert": "Resource alert",
};

function titleFromEventType(eventType: LifecycleEventType): string {
  return TITLES[eventType];
}

export function createLifecycleSubsystem(deps: SubsystemDeps): SubsystemResult<LifecycleSubsystem> {
  const repo = new LifecycleRepo(deps.db);

  const api: LifecycleSubsystem = {
    async record(input) {
      repo.record(input.eventType, input.severity, input.message, input.detail);

      try {
        await deps.ctx.push.notify(
          "",
          titleFromEventType(input.eventType),
          input.message,
          { eventType: input.eventType, ...(input.detail ?? {}) },
        );
      } catch (e) {
        deps.log.warn("lifecycle push notify failed", {
          eventType: input.eventType,
          error: (e as Error).message,
        });
      }
    },

    list(limit = DEFAULT_LIMIT, beforeTs) {
      const fetchSize = limit + 1;
      const rows = repo.list(fetchSize, beforeTs);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1]?.timestamp : undefined;
      return nextCursor ? { items, nextCursor } : { items };
    },
  };

  return { api };
}
