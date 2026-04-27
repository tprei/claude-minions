import { useState } from "react";
import type { Memory, ReviewMemoryRequest } from "@minions/shared";
import { cx } from "../util/classnames.js";

interface Props {
  memory: Memory;
  supersededMemory?: Memory;
  allMemories: Memory[];
  onReview: (req: ReviewMemoryRequest) => Promise<void>;
  onEdit: () => void;
  onClose: () => void;
}

export function MemoryReview({ memory, supersededMemory, allMemories, onReview, onEdit, onClose }: Props) {
  const [rejectReason, setRejectReason] = useState("");
  const [supersedesId, setSupersedesId] = useState<string>("");
  const [mode, setMode] = useState<"view" | "reject" | "supersede">("view");
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(req: ReviewMemoryRequest) {
    setActing(true);
    setError(null);
    try {
      await onReview(req);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
      setActing(false);
    }
  }

  const candidates = allMemories.filter(
    m => m.id !== memory.id && m.status === "approved"
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs text-fg-subtle mb-1">
            {memory.scope === "repo" && memory.repoId
              ? `repo:${memory.repoId}`
              : "global"}{" "}
            · {memory.kind}
            {memory.proposedBy && ` · by ${memory.proposedBy}`}
          </p>
          <h3 className="text-base font-semibold text-fg">{memory.title}</h3>
        </div>
        <span className={cx(
          "pill shrink-0",
          memory.status === "pending" ? "bg-yellow-900/40 text-yellow-300" : "bg-bg-elev/40 text-fg-muted"
        )}>
          {memory.status}
        </span>
      </div>

      {memory.supersedes && (
        <div className="rounded-lg bg-bg-soft border border-border p-3">
          <p className="text-xs text-fg-subtle mb-1">Supersedes</p>
          {supersededMemory ? (
            <div>
              <p className="text-sm font-medium text-fg-muted">{supersededMemory.title}</p>
              <p className="text-xs text-fg-subtle mt-1 line-clamp-3">{supersededMemory.body}</p>
            </div>
          ) : (
            <p className="text-xs text-fg-muted">ID: {memory.supersedes}</p>
          )}
        </div>
      )}

      <div className="rounded-lg bg-bg-soft border border-border p-3">
        <p className="text-xs text-fg-subtle mb-2">Body</p>
        <pre className="text-sm text-fg-muted whitespace-pre-wrap font-sans">{memory.body}</pre>
      </div>

      {memory.rejectionReason && (
        <div className="rounded-lg bg-red-950/30 border border-red-900/40 p-3">
          <p className="text-xs text-red-400 mb-1">Rejection reason</p>
          <p className="text-sm text-fg-muted">{memory.rejectionReason}</p>
        </div>
      )}

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {mode === "reject" && (
        <div className="flex flex-col gap-2">
          <label className="text-xs text-fg-muted">Rejection reason (optional)</label>
          <input
            className="input"
            value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
            placeholder="Why are you rejecting this?"
          />
          <div className="flex gap-2">
            <button className="btn" onClick={() => setMode("view")}>Back</button>
            <button
              className="btn bg-red-900/40 border-red-700 text-red-300 hover:bg-red-900/60"
              disabled={acting}
              onClick={() => act({ decision: "reject", reason: rejectReason || undefined })}
            >
              {acting ? "Rejecting…" : "Confirm reject"}
            </button>
          </div>
        </div>
      )}

      {mode === "supersede" && (
        <div className="flex flex-col gap-2">
          <label className="text-xs text-fg-muted">Pick memory to supersede</label>
          <select
            className="input"
            value={supersedesId}
            onChange={e => setSupersedesId(e.target.value)}
          >
            <option value="">— select —</option>
            {candidates.map(c => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <button className="btn" onClick={() => setMode("view")}>Back</button>
            <button
              className="btn-primary"
              disabled={acting || !supersedesId}
              onClick={() => act({ decision: "supersede", supersedesId })}
            >
              {acting ? "…" : "Confirm supersede"}
            </button>
          </div>
        </div>
      )}

      {mode === "view" && (
        <div className="flex flex-wrap gap-2 pt-1">
          {memory.status === "pending" && (
            <>
              <button
                className="btn bg-green-900/40 border-green-700 text-green-300 hover:bg-green-900/60"
                disabled={acting}
                onClick={() => act({ decision: "approve" })}
              >
                {acting ? "…" : "Approve"}
              </button>
              <button
                className="btn bg-red-900/40 border-red-700 text-red-300 hover:bg-red-900/60"
                disabled={acting}
                onClick={() => setMode("reject")}
              >
                Reject
              </button>
              <button
                className="btn"
                disabled={acting}
                onClick={() => setMode("supersede")}
              >
                Supersede
              </button>
            </>
          )}
          <button className="btn" onClick={onEdit}>Edit</button>
          <button
            className="btn border-red-800 text-red-400 hover:bg-red-950/40 ml-auto"
            disabled={acting}
            onClick={() => act({ decision: "delete" })}
          >
            Delete
          </button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      )}
    </div>
  );
}
