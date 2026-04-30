import { useEffect, useState, type ReactElement } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { postCommand } from "../transport/rest.js";
import type { Connection } from "../connections/store.js";

export interface CancelSessionDialogProps {
  open: boolean;
  onClose: () => void;
  sessions: Array<{ slug: string; title: string }>;
  conn: Connection;
}

export function CancelSessionDialog({
  open,
  onClose,
  sessions,
  conn,
}: CancelSessionDialogProps): ReactElement {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const multi = sessions.length > 1;
  const title = multi ? `Cancel ${sessions.length} sessions?` : "Cancel session";
  const confirmLabel = multi ? "Cancel sessions" : "Cancel session";

  const body = (
    <div className="flex flex-col gap-3">
      {multi ? (
        <>
          <ul className="list-disc pl-5">
            {sessions.map(s => (
              <li key={s.slug}>
                <span className="font-medium">{s.title}</span>{" "}
                <span className="text-fg-muted">({s.slug})</span>
              </li>
            ))}
          </ul>
          <p>Worktree preserved; you can re-spawn.</p>
        </>
      ) : sessions[0] ? (
        <p>
          Cancel {sessions[0].title} ({sessions[0].slug})? Worktree preserved;
          you can re-spawn.
        </p>
      ) : null}
      <input
        type="text"
        placeholder="Reason (optional)"
        value={reason}
        onChange={e => setReason(e.target.value)}
        className="w-full rounded border border-border bg-bg px-2 py-1 text-sm"
      />
    </div>
  );

  const onConfirm = async (): Promise<void> => {
    const trimmed = reason.trim();
    await Promise.all(
      sessions.map(s =>
        postCommand(conn, {
          kind: "stop",
          sessionSlug: s.slug,
          ...(trimmed ? { reason: trimmed } : {}),
        }),
      ),
    );
  };

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title={title}
      body={body}
      confirmLabel={confirmLabel}
      variant="danger"
    />
  );
}
