import { useState } from "react";
import type { Memory, MemoryKind, MemoryStatus } from "@minions/shared";
import { cx } from "../util/classnames.js";
import type { MemoryFilter } from "./types.js";

const KIND_COLOR: Record<MemoryKind, string> = {
  user: "bg-violet-900/40 text-violet-300",
  feedback: "bg-amber-900/40 text-amber-300",
  project: "bg-blue-900/40 text-blue-300",
  reference: "bg-emerald-900/40 text-emerald-300",
};

const STATUS_COLOR: Record<MemoryStatus, string> = {
  pending: "bg-yellow-900/40 text-yellow-300",
  approved: "bg-green-900/40 text-green-300",
  rejected: "bg-red-900/40 text-red-300",
  superseded: "bg-zinc-700/40 text-zinc-400",
  pending_deletion: "bg-red-900/40 text-red-400",
};

const MAX_RENDER = 200;

interface Props {
  memories: Memory[];
  filter: MemoryFilter;
  onSelect: (memory: Memory) => void;
}

export function MemoryList({ memories, filter, onSelect }: Props) {
  const [page, setPage] = useState(0);

  const filtered = memories.filter(m => {
    if (filter.tab !== "all" && m.status !== filter.tab) return false;
    if (filter.search) {
      const q = filter.search.toLowerCase();
      if (!m.title.toLowerCase().includes(q) && !m.body.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const visible = filtered.slice(0, MAX_RENDER + page * MAX_RENDER);

  if (filtered.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-zinc-500 text-sm">
        No memories found
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border">
      {visible.map(m => (
        <MemoryRow key={m.id} memory={m} onClick={() => onSelect(m)} />
      ))}
      {filtered.length > visible.length && (
        <button
          className="btn mx-4 my-3 self-center"
          onClick={() => setPage(p => p + 1)}
        >
          Load more ({filtered.length - visible.length} remaining)
        </button>
      )}
    </div>
  );
}

interface RowProps {
  memory: Memory;
  onClick: () => void;
}

function MemoryRow({ memory, onClick }: RowProps) {
  return (
    <button
      className="w-full text-left px-4 py-3 hover:bg-bg-soft transition-colors group"
      onClick={onClick}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={cx("pill", KIND_COLOR[memory.kind])}>{memory.kind}</span>
            <span className={cx("pill", STATUS_COLOR[memory.status])}>{memory.status}</span>
            {memory.pinned && (
              <span className="text-amber-400 text-xs" title="Pinned">★</span>
            )}
            <span className="text-xs text-zinc-500 ml-auto shrink-0">
              {memory.scope === "repo" && memory.repoId
                ? `repo:${memory.repoId}`
                : "global"}
            </span>
          </div>
          <p className="text-sm font-medium text-zinc-200 truncate">{memory.title}</p>
          <p className="text-xs text-zinc-400 mt-0.5 line-clamp-2">{memory.body}</p>
        </div>
      </div>
    </button>
  );
}
