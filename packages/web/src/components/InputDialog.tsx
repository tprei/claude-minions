import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import { Modal } from "./Modal.js";
import { Button } from "./Button.js";

export interface InputDialogProps {
  open: boolean;
  title: string;
  label: string;
  initialValue?: number;
  min?: number;
  step?: number;
  confirmLabel?: string;
  onConfirm: (value: number) => Promise<void> | void;
  onCancel: () => void;
}

function toInputString(v: number | undefined): string {
  if (v === undefined || Number.isNaN(v)) return "";
  return String(v);
}

export function InputDialog({
  open,
  title,
  label,
  initialValue,
  min,
  step,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
}: InputDialogProps): ReactElement {
  const [text, setText] = useState<string>(() => toInputString(initialValue));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setText(toInputString(initialValue));
      setPending(false);
      setError(null);
    }
  }, [open, initialValue]);

  const parsed = text.trim() === "" ? Number.NaN : Number(text);
  const valueValid = Number.isFinite(parsed) && (min === undefined || parsed >= min);

  const handleClose = useCallback(() => {
    if (pending) return;
    onCancel();
  }, [pending, onCancel]);

  const handleConfirm = useCallback(async () => {
    if (!valueValid || pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm(parsed);
      onCancel();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setPending(false);
    }
  }, [valueValid, pending, parsed, onConfirm, onCancel]);

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleConfirm();
    }
  };

  return (
    <Modal open={open} onClose={handleClose} title={title}>
      <div className="flex flex-col gap-4 text-sm">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-fg-muted">{label}</span>
          <input
            type="number"
            inputMode="decimal"
            className="input"
            value={text}
            min={min}
            step={step}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            disabled={pending}
          />
        </label>
        {error && (
          <div className="card p-2 text-xs text-err border border-err/30 bg-err/10">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={pending || !valueValid}>
            {pending ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
