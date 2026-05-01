import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Session } from "@minions/shared";
import type { Connection } from "../connections/store.js";
import { cx } from "../util/classnames.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { Sheet } from "../components/Sheet.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { hapticTap } from "../pwa/haptics.js";
import { deleteSession, postCommand } from "../transport/rest.js";
import { CancelSessionDialog } from "./cancelSession.js";

interface Props {
  session: Session;
  conn: Connection;
  onAfterDelete?: () => void;
  className?: string;
}

type DialogKind = "cancel" | "close" | "delete" | null;

const CANCELLABLE_STATUSES: ReadonlySet<Session["status"]> = new Set([
  "pending",
  "running",
  "waiting_input",
]);
const TERMINAL_STATUSES: ReadonlySet<Session["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function SessionActionsMenu({
  session,
  conn,
  onAfterDelete,
  className,
}: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const isMobile = useMediaQuery("(max-width: 767px)");

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open || isMobile) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open, close, isMobile]);

  const canCancel = CANCELLABLE_STATUSES.has(session.status);
  const canClose = TERMINAL_STATUSES.has(session.status) && Boolean(session.worktreePath);

  const onAction = (kind: Exclude<DialogKind, null>): void => {
    setOpen(false);
    setDialog(kind);
  };

  const onDeleteConfirm = useCallback(async (): Promise<void> => {
    await deleteSession(conn, session.slug);
    onAfterDelete?.();
  }, [conn, session.slug, onAfterDelete]);

  const onCloseConfirm = useCallback(async (): Promise<void> => {
    await postCommand(conn, {
      kind: "close",
      sessionSlug: session.slug,
      removeWorktree: true,
    });
  }, [conn, session.slug]);

  return (
    <span className={cx("relative inline-flex", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Session actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => {
            const next = !v;
            if (next) hapticTap();
            return next;
          });
        }}
        className="pill bg-bg-elev text-fg-muted hover:text-fg cursor-pointer text-xs px-2 py-0.5 leading-none"
      >
        ⋯
      </button>
      {open && !isMobile && (
        <div
          ref={popoverRef}
          id={menuId}
          role="menu"
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full mt-1 z-30 min-w-[10rem] card p-1 shadow-lg"
        >
          {canCancel && (
            <MenuItem onClick={() => onAction("cancel")}>Cancel</MenuItem>
          )}
          {canClose && (
            <MenuItem onClick={() => onAction("close")}>Close</MenuItem>
          )}
          <MenuItem onClick={() => onAction("delete")} variant="danger">
            Delete…
          </MenuItem>
        </div>
      )}
      {isMobile && (
        <Sheet open={open} onClose={close} title={session.title}>
          <div
            id={menuId}
            role="menu"
            onClick={(e) => e.stopPropagation()}
            className="flex flex-col gap-2"
          >
            {canCancel && (
              <MenuItem mobile onClick={() => onAction("cancel")}>Cancel</MenuItem>
            )}
            {canClose && (
              <MenuItem mobile onClick={() => onAction("close")}>Close</MenuItem>
            )}
            <MenuItem mobile onClick={() => onAction("delete")} variant="danger">
              Delete…
            </MenuItem>
          </div>
        </Sheet>
      )}

      {canCancel && (
        <CancelSessionDialog
          open={dialog === "cancel"}
          onClose={() => setDialog(null)}
          sessions={[{ slug: session.slug, title: session.title }]}
          conn={conn}
        />
      )}
      <ConfirmDialog
        open={dialog === "close"}
        onClose={() => setDialog(null)}
        onConfirm={onCloseConfirm}
        title="Close session"
        body={
          <p>
            Cancel {session.title} ({session.slug}) and remove its worktree on
            disk? Transcript and history are preserved.
          </p>
        }
        confirmLabel="Close session"
        variant="danger"
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onClose={() => setDialog(null)}
        onConfirm={onDeleteConfirm}
        title="Delete session"
        body={
          <p>
            Permanently delete {session.title} ({session.slug})? This removes
            the session row, transcript, screenshots, checkpoints, worktree on
            disk, and uploads. Cannot be undone.
          </p>
        }
        confirmLabel="Delete session"
        variant="danger"
      />
    </span>
  );
}

function MenuItem({
  onClick,
  children,
  variant = "default",
  mobile = false,
}: {
  onClick: () => void;
  children: ReactNode;
  variant?: "default" | "danger";
  mobile?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cx(
        "block w-full text-left rounded hover:bg-bg-soft transition-colors",
        mobile ? "min-h-11 px-3 py-2 text-sm" : "px-2 py-1 text-xs",
        variant === "danger" ? "text-red-400 hover:text-red-300" : "text-fg-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
