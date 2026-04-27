import type { Memory, MemoryReviewCommand } from "@minions/shared";
import type { EventBus } from "../bus/eventBus.js";
import type { MemoryStore } from "./store.js";
import { EngineError } from "../errors.js";
import { nowIso } from "../util/time.js";

export function review(
  store: MemoryStore,
  bus: EventBus,
  id: string,
  req: MemoryReviewCommand
): Memory {
  const memory = store.getById(id);
  if (!memory) {
    throw new EngineError("not_found", `Memory ${id} not found`);
  }

  let updated: Memory;

  switch (req.decision) {
    case "approve": {
      updated = store.save({
        ...memory,
        status: "approved",
        reviewedAt: nowIso(),
      });
      break;
    }
    case "reject": {
      updated = store.save({
        ...memory,
        status: "rejected",
        rejectionReason: req.reason ?? undefined,
        reviewedAt: nowIso(),
      });
      break;
    }
    case "delete": {
      updated = store.save({
        ...memory,
        status: "pending_deletion",
        reviewedAt: nowIso(),
      });
      break;
    }
    case "supersede": {
      if (!req.supersedesId) {
        throw new EngineError("bad_request", "supersedesId is required for supersede decision");
      }
      const newMemory = store.getById(req.supersedesId);
      if (!newMemory) {
        throw new EngineError("not_found", `Memory ${req.supersedesId} not found`);
      }
      updated = store.save({
        ...memory,
        status: "superseded",
        supersedes: req.supersedesId,
        reviewedAt: nowIso(),
      });
      break;
    }
  }

  bus.emit({ kind: "memory_reviewed", memory: updated });
  return updated;
}
