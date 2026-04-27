import { useState } from "react";
import type { TranscriptEvent } from "@minions/shared";
import { useRootStore } from "../store/root.js";
import { postCommand } from "../transport/rest.js";
import { cx } from "../util/classnames.js";

interface Props {
  event: TranscriptEvent;
  sessionSlug: string;
}

const REASONS = [
  "Wrong answer",
  "Incomplete",
  "Hallucination",
  "Bad style",
  "Other",
];

export function MessageFeedback({ event, sessionSlug }: Props) {
  const [voted, setVoted] = useState<"up" | "down" | null>(null);
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const conn = useRootStore((s) => s.getActiveConnection());

  const submit = async (rating: "up" | "down", r?: string) => {
    if (!conn) return;
    setSubmitting(true);
    try {
      await postCommand(conn, {
        kind: "submit-feedback",
        sessionSlug,
        eventId: event.id,
        rating,
        reason: r || undefined,
      });
      setVoted(rating);
      setShowReason(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (voted) {
    return (
      <div className="flex items-center gap-1 text-[10px] text-fg-subtle">
        {voted === "up" ? "👍" : "👎"} feedback recorded
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 relative">
      <button
        type="button"
        disabled={submitting}
        onClick={() => submit("up")}
        className="text-fg-subtle hover:text-green-400 text-xs transition-colors"
        title="Thumbs up"
      >
        👍
      </button>
      <button
        type="button"
        disabled={submitting}
        onClick={() => setShowReason((v) => !v)}
        className="text-fg-subtle hover:text-red-400 text-xs transition-colors"
        title="Thumbs down"
      >
        👎
      </button>
      {showReason && (
        <div className="absolute bottom-full left-0 mb-1 bg-bg-elev border border-border rounded-xl p-3 shadow-xl z-50 w-52">
          <p className="text-xs text-fg-muted mb-2">What went wrong?</p>
          <div className="flex flex-col gap-1 mb-2">
            {REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => {
                  setReason(r);
                  void submit("down", r);
                }}
                className={cx(
                  "text-left text-xs px-2 py-1 rounded hover:bg-bg-soft transition-colors",
                  reason === r ? "text-fg" : "text-fg-muted",
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <input
            type="text"
            placeholder="Custom reason…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit("down", reason);
            }}
            className="input w-full text-xs"
          />
        </div>
      )}
    </div>
  );
}
