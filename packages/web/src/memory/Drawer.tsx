import { useState, useEffect, useCallback, useMemo } from "react";
import type { Memory, CreateMemoryRequest, MemoryReviewCommand, MemoryStatus, RepoBinding } from "@minions/shared";
import { cx } from "../util/classnames.js";
import { MemoryList } from "./list.js";
import { MemoryEdit } from "./edit.js";
import { MemoryReview } from "./review.js";
import type { MemoryTab } from "./types.js";
import { useConnectionStore } from "../connections/store.js";
import { useVersionStore } from "../store/version.js";
import { useMemoryStore } from "../store/memoryStore.js";
import { listMemories } from "../transport/rest.js";
import { Banner } from "../components/Banner.js";
import { useApiMutation, type MutationError } from "../hooks/useApiMutation.js";

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
  | { kind: "review"; memory: Memory }
  | { kind: "propose" };

const TABS: { id: MemoryTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "superseded", label: "Superseded" },
  { id: "pending_deletion", label: "Pending delete" },
];

const SEARCH_DEBOUNCE_MS = 200;

const EMPTY_REPOS: RepoBinding[] = [];

interface SaveArgs {
  body: CreateMemoryRequest | Partial<CreateMemoryRequest>;
  memoryId?: string;
}

interface ReviewArgs {
  memoryId: string;
  body: MemoryReviewCommand;
}

export function MemoryDrawer({ api, onClose }: Props) {
  const activeId = useConnectionStore(s => s.activeId);
  const conn = useConnectionStore(s =>
    activeId ? s.connections.find(c => c.id === activeId) ?? null : null,
  );
  const repos = useVersionStore(s =>
    activeId ? s.byConnection.get(activeId)?.repos ?? EMPTY_REPOS : EMPTY_REPOS,
  );

  const [items, setItems] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<MutationError | null>(null);
  const [tab, setTab] = useState<MemoryTab>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [repoId, setRepoId] = useState<string>("all");
  const [mode, setMode] = useState<DrawerMode>({ kind: "list" });

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    if (!conn) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const opts: Parameters<typeof listMemories>[1] = {};
      if (tab !== "all") opts.status = tab as MemoryStatus;
      if (debouncedSearch.trim()) opts.q = debouncedSearch.trim();
      if (repoId !== "all") opts.repoId = repoId;
      const res = await listMemories(conn, opts);
      setItems(res.items);
      if (activeId) {
        const store = useMemoryStore.getState();
        for (const m of res.items) store.upsert(activeId, m);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load memories");
    } finally {
      setLoading(false);
    }
  }, [conn, tab, debouncedSearch, repoId, activeId]);

  useEffect(() => { void load(); }, [load]);

  const filteredItems = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return items.filter(m => {
      if (repoId !== "all") {
        if (m.scope !== "repo" || m.repoId !== repoId) return false;
      }
      if (q) {
        if (!m.title.toLowerCase().includes(q) && !m.body.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [items, debouncedSearch, repoId]);

  const saveMutation = useApiMutation<SaveArgs, unknown>(
    async ({ body, memoryId }) => {
      if (memoryId) return api.patch(`/api/memories/${memoryId}`, body);
      return api.post("/api/memories", body);
    },
    {
      onSuccess: async () => {
        setMutationError(null);
        await load();
        setMode({ kind: "list" });
      },
      onError: (err) => setMutationError(err),
    },
  );

  const proposeMutation = useApiMutation<CreateMemoryRequest | Partial<CreateMemoryRequest>, unknown>(
    (body) => api.post("/api/memories", body),
    {
      onSuccess: () => {
        setMutationError(null);
        setMode({ kind: "list" });
      },
      onError: (err) => setMutationError(err),
    },
  );

  const reviewMutation = useApiMutation<ReviewArgs, unknown>(
    ({ memoryId, body }) => api.patch(`/api/memories/${memoryId}/review`, body),
    {
      onSuccess: async (_res, args) => {
        setMutationError(null);
        await load();
        if (mode.kind === "review" && mode.memory.id === args.memoryId) {
          setMode({ kind: "list" });
        }
      },
      onError: (err) => setMutationError(err),
    },
  );

  async function handleSave(req: CreateMemoryRequest | Partial<CreateMemoryRequest>) {
    if (mode.kind === "edit" && mode.memory) {
      const result = await saveMutation.run({ body: req, memoryId: mode.memory.id });
      if (result === undefined) throw new Error(saveMutation.error?.message ?? "Save failed");
    } else {
      const result = await saveMutation.run({ body: req });
      if (result === undefined) throw new Error(saveMutation.error?.message ?? "Save failed");
    }
  }

  async function handlePropose(req: CreateMemoryRequest | Partial<CreateMemoryRequest>) {
    const result = await proposeMutation.run(req);
    if (result === undefined) throw new Error(proposeMutation.error?.message ?? "Propose failed");
  }

  async function handleReview(memory: Memory, req: MemoryReviewCommand) {
    const result = await reviewMutation.run({ memoryId: memory.id, body: req });
    if (result === undefined) throw new Error(reviewMutation.error?.message ?? "Review failed");
  }

  async function handleQuickReview(memory: Memory, req: MemoryReviewCommand) {
    await reviewMutation.run({ memoryId: memory.id, body: req });
  }

  const activeMemory = mode.kind === "review" || mode.kind === "edit" ? mode.memory : undefined;
  const supersededMemory = mode.kind === "review" && activeMemory?.supersedes
    ? items.find(m => m.id === activeMemory.supersedes)
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
        <h2 className="text-sm font-semibold text-fg-muted flex-1">
          {mode.kind === "list" && "Memories"}
          {mode.kind === "edit" && (mode.memory ? "Edit Memory" : "New Memory")}
          {mode.kind === "review" && "Review Memory"}
          {mode.kind === "propose" && "Propose Memory"}
        </h2>
        {mode.kind === "list" && (
          <button
            className="btn text-xs"
            onClick={load}
            disabled={loading}
            aria-label="Refresh"
          >
            {loading ? "…" : "↺"}
          </button>
        )}
        <button className="btn p-1.5" onClick={onClose} aria-label="Close">✕</button>
      </div>

      {mutationError && (
        <div className="px-4 pt-3 shrink-0">
          <Banner
            tone="error"
            title={mutationError.code}
            message={mutationError.message}
            detail={mutationError.status ? `HTTP ${mutationError.status}` : undefined}
            onDismiss={() => setMutationError(null)}
          />
        </div>
      )}

      {mode.kind === "list" && (
        <>
          <div className="px-4 py-2 border-b border-border shrink-0">
            <button
              className="btn-primary text-xs w-full"
              onClick={() => setMode({ kind: "propose" })}
            >
              + Propose memory
            </button>
          </div>

          <div className="px-4 py-2 border-b border-border shrink-0">
            <input
              className="input w-full text-xs"
              placeholder="Search title or body…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-1 px-4 py-2 border-b border-border shrink-0 overflow-x-auto">
            {TABS.map(t => (
              <button
                key={t.id}
                className={cx(
                  "pill cursor-pointer border whitespace-nowrap",
                  tab === t.id
                    ? "bg-accent/20 border-accent text-accent"
                    : "border-border text-fg-muted hover:text-fg-muted",
                )}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="px-4 py-2 border-b border-border shrink-0">
            <select
              className="input w-full text-xs"
              value={repoId}
              onChange={e => setRepoId(e.target.value)}
              aria-label="Filter by repo"
            >
              <option value="all">All repos</option>
              {repos.map(r => (
                <option key={r.id} value={r.id}>{r.label || r.id}</option>
              ))}
            </select>
          </div>
        </>
      )}

      <div className="flex-1 overflow-y-auto">
        {loadError && (
          <div className="p-4 text-red-400 text-sm">{loadError}</div>
        )}

        {mode.kind === "list" && !loadError && (
          loading ? (
            <div className="flex justify-center py-12">
              <div className="w-5 h-5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
            </div>
          ) : (
            <MemoryList
              memories={filteredItems}
              onSelect={m => setMode({ kind: "review", memory: m })}
              onApprove={m => handleQuickReview(m, { decision: "approve" })}
              onReject={m => handleQuickReview(m, { decision: "reject" })}
              onEdit={m => setMode({ kind: "edit", memory: m })}
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

        {mode.kind === "propose" && (
          <MemoryEdit
            onSave={handlePropose}
            onCancel={() => setMode({ kind: "list" })}
          />
        )}

        {mode.kind === "review" && (
          <MemoryReview
            memory={mode.memory}
            supersededMemory={supersededMemory}
            allMemories={items}
            onReview={req => handleReview(mode.memory, req)}
            onEdit={() => setMode({ kind: "edit", memory: mode.memory })}
            onClose={() => setMode({ kind: "list" })}
          />
        )}
      </div>
    </div>
  );
}
