import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import type { EngineContext } from "../context.js";
import { StatsComputer } from "./computer.js";

export function createStatsSubsystem(
  deps: SubsystemDeps
): SubsystemResult<EngineContext["stats"]> {
  const computer = new StatsComputer(deps.db);

  return {
    api: {
      global: () => computer.global(),
      modes: () => computer.modes(),
      recent: (hours?: number) => computer.recent(hours),
      promText: () => computer.promText(),
    },
  };
}
