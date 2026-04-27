import type { ShipStage } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { ShipCoordinator } from "./coordinator.js";

export function createShipSubsystem(deps: SubsystemDeps): SubsystemResult<EngineContext["ship"]> {
  const { ctx, db, log } = deps;

  const coordinator = new ShipCoordinator(db, ctx, log.child({ subsystem: "ship-coordinator" }));

  const api: EngineContext["ship"] = {
    async advance(slug: string, toStage?: ShipStage, note?: string): Promise<void> {
      await coordinator.advance(slug, toStage, note);
    },

    async onTurnCompleted(slug: string): Promise<void> {
      await coordinator.onTurnCompleted(slug);
    },
  };

  return { api };
}

export { ShipCoordinator } from "./coordinator.js";
