import { useEffect, type ReactElement, type ReactNode } from "react";
import { cx } from "../util/classnames.js";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, children, className }: ModalProps): ReactElement | null {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className={cx("relative card p-6 w-full max-w-md shadow-2xl", className)}>
        {title && (
          <h2 className="text-sm font-semibold text-zinc-100 mb-4">{title}</h2>
        )}
        {children}
      </div>
    </div>
  );
}
