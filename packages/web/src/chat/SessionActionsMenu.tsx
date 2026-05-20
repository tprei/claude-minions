import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { TaskStackStatus, Workflow } from "@minions/engine";
import type { Connection } from "../connections/store.js";
import { cx } from "../util/classnames.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { Sheet } from "../components/Sheet.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { hapticTap } from "../pwa/haptics.js";
import { dispatchCommand, deleteWorkflow } from "../transport/rest.js";
import { useWorkflowStore } from "../store/workflowStore.js";

interface Props {
  workflow: Workflow;
  conn: Connection;
  onAfterDelete?: () => void;
  className?: string;
}

type DialogKind = "cancel" | "delete" | null;

const ACTIVE_STATUSES = new Set(["active"]);

export function SessionActionsMenu({
  workflow,
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

  const canCancel = ACTIVE_STATUSES.has(workflow.status);

  const nonCleanStack = Object.values(workflow.graph)
    .map((t) => t.stackStatus)
    .find((s): s is Exclude<TaskStackStatus, "clean"> => s !== "clean");

  const onAction = (kind: Exclude<DialogKind, null>): void => {
    setOpen(false);
    setDialog(kind);
  };

  const onCancelConfirm = useCallback(async (): Promise<void> => {
    const firstTask = Object.values(workflow.graph)[0];
    if (!firstTask) return;
    await dispatchCommand(conn, {
      kind: "transition-task",
      workflowId: workflow.id,
      transition: {
        kind: "cancel-task",
        taskId: firstTask.id,
        now: new Date().toISOString(),
      },
    });
  }, [conn, workflow]);

  const onDeleteConfirm = useCallback(async (): Promise<void> => {
    await deleteWorkflow(conn, workflow.id);
    useWorkflowStore.getState().remove(conn.id, workflow.id);
    onAfterDelete?.();
  }, [conn, workflow.id, onAfterDelete]);

  return (
    <span className={cx("relative inline-flex", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Task actions"
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
          {nonCleanStack && (
            <div className="px-2 py-1 text-[10px] text-amber-600 dark:text-amber-400 border-b border-border mb-1">
              Stack: {nonCleanStack}
            </div>
          )}
          {canCancel && (
            <MenuItem onClick={() => onAction("cancel")}>Cancel</MenuItem>
          )}
          <MenuItem onClick={() => onAction("delete")} variant="danger">
            Remove…
          </MenuItem>
        </div>
      )}
      {isMobile && open && (
        <Sheet open={open} onClose={close} title={workflow.id}>
          <div
            id={menuId}
            role="menu"
            onClick={(e) => e.stopPropagation()}
            className="flex flex-col gap-2"
          >
            {nonCleanStack && (
              <div className="px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                Stack: {nonCleanStack}
              </div>
            )}
            {canCancel && (
              <MenuItem mobile onClick={() => onAction("cancel")}>Cancel</MenuItem>
            )}
            <MenuItem mobile onClick={() => onAction("delete")} variant="danger">
              Remove…
            </MenuItem>
          </div>
        </Sheet>
      )}

      {canCancel && (
        <ConfirmDialog
          open={dialog === "cancel"}
          onClose={() => setDialog(null)}
          onConfirm={onCancelConfirm}
          title="Cancel task"
          body={<p>Cancel all running tasks in this workflow?</p>}
          confirmLabel="Cancel task"
          variant="danger"
        />
      )}
      <ConfirmDialog
        open={dialog === "delete"}
        onClose={() => setDialog(null)}
        onConfirm={onDeleteConfirm}
        title="Remove workflow"
        body={<p>Remove this workflow from the list? This only removes it from the local view.</p>}
        confirmLabel="Remove"
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
