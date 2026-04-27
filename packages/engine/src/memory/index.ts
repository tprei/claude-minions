import type { Memory, CreateMemoryRequest, ReviewMemoryRequest, MemoryStatus, MemoryKind } from "@minions/shared";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { MemoryStore } from "./store.js";
import { review as doReview } from "./review.js";
import { renderPreamble as doRenderPreamble } from "./preamble.js";
import { EngineError } from "../errors.js";

export interface MemorySubsystem {
  list: (filter?: { status?: MemoryStatus; kind?: MemoryKind }) => Memory[];
  get: (id: string) => Memory | null;
  create: (req: CreateMemoryRequest) => Promise<Memory>;
  update: (id: string, patch: Partial<Pick<Memory, "title" | "body" | "pinned">>) => Promise<Memory>;
  review: (id: string, req: ReviewMemoryRequest) => Promise<Memory>;
  delete: (id: string) => Promise<void>;
  renderPreamble: (repoId?: string) => string;
}

export function createMemorySubsystem(deps: SubsystemDeps): SubsystemResult<MemorySubsystem> {
  const store = new MemoryStore(deps.db);

  const api: MemorySubsystem = {
    list(filter) {
      return store.list(filter);
    },

    get(id) {
      return store.getById(id);
    },

    async create(req) {
      const memory = store.insert({
        kind: req.kind,
        status: "pending",
        scope: req.scope,
        repoId: req.repoId,
        pinned: req.pinned ?? false,
        title: req.title,
        body: req.body,
        proposedBy: undefined,
        proposedFromSession: req.proposedFromSession,
        reviewedBy: undefined,
        reviewedAt: undefined,
        rejectionReason: undefined,
        supersedes: undefined,
      });
      deps.bus.emit({ kind: "memory_proposed", memory });
      deps.log.info("memory created", { id: memory.id, kind: memory.kind, status: memory.status });
      return memory;
    },

    async update(id, patch) {
      const existing = store.getById(id);
      if (!existing) {
        throw new EngineError("not_found", `Memory ${id} not found`);
      }
      const updated = store.save({
        ...existing,
        title: patch.title ?? existing.title,
        body: patch.body ?? existing.body,
        pinned: patch.pinned ?? existing.pinned,
      });
      deps.bus.emit({ kind: "memory_updated", memory: updated });
      return updated;
    },

    async review(id, req) {
      const updated = doReview(store, deps.bus, id, req);
      deps.log.info("memory reviewed", { id, decision: req.decision });
      return updated;
    },

    async delete(id) {
      const existing = store.getById(id);
      if (!existing) {
        throw new EngineError("not_found", `Memory ${id} not found`);
      }
      store.remove(id);
      deps.bus.emit({ kind: "memory_deleted", id });
      deps.log.info("memory deleted", { id });
    },

    renderPreamble(repoId) {
      return doRenderPreamble(store, repoId);
    },
  };

  return { api };
}
