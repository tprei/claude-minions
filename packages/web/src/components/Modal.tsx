import { useEffect, type ReactElement, type ReactNode } from "react";
import { cx } from "../util/classnames.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { Sheet } from "./Sheet.js";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, children, className }: ModalProps): ReactElement | null {
  const isMobile = useMediaQuery("(max-width: 767px)");

  useEffect(() => {
    if (!open || isMobile) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose, isMobile]);

  if (!open) return null;

  if (isMobile) {
    return (
      <Sheet open={open} onClose={onClose} side="bottom" title={title} className={className}>
        {children}
      </Sheet>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className={cx("relative card p-6 w-full max-w-md shadow-2xl", className)}>
        {title && (
          <h2 className="text-sm font-semibold text-fg mb-4">{title}</h2>
        )}
        {children}
      </div>
    </div>
  );
}
