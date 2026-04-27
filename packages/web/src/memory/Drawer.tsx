import { useState, useEffect, useCallback } from "react";
import type { Memory, CreateMemoryRequest, ReviewMemoryRequest } from "@minions/shared";
import { cx } from "../util/classnames.js";
import { MemoryList } from "./list.js";
import { MemoryEdit } from "./edit.js";
import { MemoryReview } from "./review.js";
import type { MemoryTab, MemoryFilter } from "./types.js";

interface Props {
  api: {
    get: (path: string) => Promise<unknown>;
    post: (path: string, body: unknown) => Promise<unknown>;
    patch: (path: string, body: unknown) => Promise<unknown>;
    del: (path: string) => Promise<unknown>;
  };
  onClose: () => void;
}

type DrawerMode =
  | { kind: "list" }
  | { kind: "edit"; memory?: Memory }
  | { kind: "review"; memory: Memory };

const TABS: { id: MemoryTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
];

export function MemoryDrawer({ api, onClose }: Props) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<MemoryFilter>({ tab: "all", search: "" });
  const [mode, setMode] = useState<DrawerMode>({ kind: "list" });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get("/api/memories") as { items: Memory[] };
      setMemories(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load memories");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  async function handleSave(req: CreateMemoryRequest | Partial<CreateMemoryRequest>) {
    if (mode.kind === "edit" && mode.memory) {
      await api.patch(`/api/memories/${mode.memory.id}`, req);
    } else {
      await api.post("/api/memories", req);
    }
    await load();
    setMode({ kind: "list" });
  }

  async function handleReview(memory: Memory, req: ReviewMemoryRequest) {
    await api.patch(`/api/memories/${memory.id}/review`, req);
    await load();
    setMode({ kind: "list" });
  }

  const activeMemory = mode.kind === "review" || mode.kind === "edit" ? mode.memory : undefined;
  const supersededMemory = mode.kind === "review" && activeMemory?.supersedes
    ? memories.find(m => m.id === activeMemory.supersedes)
    : undefined;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        {mode.kind !== "list" && (
          <button
            className="btn p-1.5 mr-1"
            onClick={() => setMode({ kind: "list" })}
            aria-label="Back"
          >
            ←
          </button>
        )}
        <h2 className="text-sm font-semibold text-zinc-200 flex-1">
          {mode.kind === "list" && "Memories"}
          {mode.kind === "edit" && (mode.memory ? "Edit Memory" : "New Memory")}
          {mode.kind === "review" && "Review Memory"}
        </h2>
        {mode.kind === "list" && (
          <>
            <button
              className="btn text-xs"
              onClick={load}
              disabled={loading}
              aria-label="Refresh"
            >
              {loading ? "…" : "↺"}
            </button>
            <button
              className="btn-primary text-xs"
              onClick={() => setMode({ kind: "edit" })}
            >
              + New
            </button>
          </>
        )}
        <button className="btn p-1.5" onClick={onClose} aria-label="Close">✕</button>
      </div>

      {mode.kind === "list" && (
        <>
          <div className="flex items-center gap-1 px-4 py-2 border-b border-border shrink-0 overflow-x-auto">
            {TABS.map(t => (
              <button
                key={t.id}
                className={cx(
                  "pill cursor-pointer border whitespace-nowrap",
                  filter.tab === t.id
                    ? "bg-accent/20 border-accent text-accent"
                    : "border-border text-zinc-400 hover:text-zinc-200"
                )}
                onClick={() => setFilter(f => ({ ...f, tab: t.id }))}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="px-4 py-2 border-b border-border shrink-0">
            <input
              className="input w-full text-xs"
              placeholder="Search title or body…"
              value={filter.search}
              onChange={e => setFilter(f => ({ ...f, search: e.target.value }))}
            />
          </div>
        </>
      )}

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="p-4 text-red-400 text-sm">{error}</div>
        )}

        {mode.kind === "list" && !error && (
          loading ? (
            <div className="flex justify-center py-12">
              <div className="w-5 h-5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
            </div>
          ) : (
            <MemoryList
              memories={memories}
              filter={filter}
              onSelect={m => setMode({ kind: "review", memory: m })}
            />
          )
        )}

        {mode.kind === "edit" && (
          <MemoryEdit
            memory={mode.memory}
            onSave={handleSave}
            onCancel={() => setMode({ kind: "list" })}
          />
        )}

        {mode.kind === "review" && (
          <MemoryReview
            memory={mode.memory}
            supersededMemory={supersededMemory}
            allMemories={memories}
            onReview={req => handleReview(mode.memory, req)}
            onEdit={() => setMode({ kind: "edit", memory: mode.memory })}
            onClose={() => setMode({ kind: "list" })}
          />
        )}
      </div>
    </div>
  );
}
