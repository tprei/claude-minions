import { useState } from "react";
import type { Memory, MemoryKind, MemoryStatus } from "@minions/shared";
import { cx } from "../util/classnames.js";

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
  superseded: "bg-bg-elev/40 text-fg-muted",
  pending_deletion: "bg-red-900/40 text-red-400",
};

const MAX_RENDER = 200;

interface Props {
  memories: Memory[];
  onSelect: (memory: Memory) => void;
  onApprove: (memory: Memory) => void | Promise<void>;
  onReject: (memory: Memory) => void | Promise<void>;
  onEdit: (memory: Memory) => void;
}

export function MemoryList({ memories, onSelect, onApprove, onReject, onEdit }: Props) {
  const [page, setPage] = useState(0);

  const visible = memories.slice(0, MAX_RENDER + page * MAX_RENDER);

  if (memories.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-fg-subtle text-sm">
        No memories found
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border">
      {visible.map(m => (
        <MemoryRow
          key={m.id}
          memory={m}
          onClick={() => onSelect(m)}
          onApprove={() => onApprove(m)}
          onReject={() => onReject(m)}
          onEdit={() => onEdit(m)}
        />
      ))}
      {memories.length > visible.length && (
        <button
          className="btn mx-4 my-3 self-center"
          onClick={() => setPage(p => p + 1)}
        >
          Load more ({memories.length - visible.length} remaining)
        </button>
      )}
    </div>
  );
}

interface RowProps {
  memory: Memory;
  onClick: () => void;
  onApprove: () => void | Promise<void>;
  onReject: () => void | Promise<void>;
  onEdit: () => void;
}

function MemoryRow({ memory, onClick, onApprove, onReject, onEdit }: RowProps) {
  const [acting, setActing] = useState(false);

  async function run(action: () => void | Promise<void>) {
    setActing(true);
    try {
      await action();
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="px-4 py-3 hover:bg-bg-soft transition-colors group">
      <button className="w-full text-left" onClick={onClick}>
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className={cx("pill", KIND_COLOR[memory.kind])}>{memory.kind}</span>
              <span className={cx("pill", STATUS_COLOR[memory.status])}>{memory.status}</span>
              {memory.pinned && (
                <span className="text-amber-400 text-xs" title="Pinned">★</span>
              )}
              <span className="text-xs text-fg-subtle ml-auto shrink-0">
                {memory.scope === "repo" && memory.repoId
                  ? `repo:${memory.repoId}`
                  : "global"}
              </span>
            </div>
            <p className="text-sm font-medium text-fg-muted truncate">{memory.title}</p>
            <p className="text-xs text-fg-muted mt-0.5 line-clamp-2">{memory.body}</p>
          </div>
        </div>
      </button>
      <div className="flex gap-2 mt-2">
        {memory.status === "pending" && (
          <>
            <button
              className="btn text-xs bg-green-900/40 border-green-700 text-green-300 hover:bg-green-900/60"
              disabled={acting}
              onClick={() => run(onApprove)}
            >
              Approve
            </button>
            <button
              className="btn text-xs bg-red-900/40 border-red-700 text-red-300 hover:bg-red-900/60"
              disabled={acting}
              onClick={() => run(onReject)}
            >
              Reject
            </button>
          </>
        )}
        <button
          className="btn text-xs"
          disabled={acting}
          onClick={onEdit}
        >
          Edit
        </button>
      </div>
    </div>
  );
}
