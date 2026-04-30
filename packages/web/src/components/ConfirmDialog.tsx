import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { Modal } from "./Modal.js";
import { Button } from "./Button.js";

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  variant?: "danger" | "default";
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  variant = "danger",
}: ConfirmDialogProps): ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPending(false);
      setError(null);
    }
  }, [open]);

  const handleClose = useCallback(() => {
    if (pending) return;
    onClose();
  }, [pending, onClose]);

  const handleConfirm = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setPending(false);
    }
  }, [onConfirm, onClose]);

  return (
    <Modal open={open} onClose={handleClose} title={title}>
      <div className="flex flex-col gap-4 text-sm">
        <div>{body}</div>
        {error && (
          <div className="card p-2 text-xs text-err border border-err/30 bg-err/10">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant={variant} onClick={handleConfirm} disabled={pending}>
            {pending ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
